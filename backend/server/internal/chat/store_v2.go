package chat

import (
	"context"
	"errors"
	"mime/multipart"
	"sort"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const (
	conversationTypeRoom   = "room"
	conversationTypeDirect = "direct"
	messageStatusSent      = "sent"
)

func (s *Store) UpsertSessionUser(ctx context.Context, payload session.Payload) error {
	now := util.NowMillisInt64()
	return upsertUserRecord(s.db.WithContext(ctx), payload.ClientID, payload.Nickname, now)
}

func (s *Store) EnsureRoom(ctx context.Context, roomID string, payload session.Payload) (protocol.RoomDetail, error) {
	roomID = util.SanitizeRoomID(roomID)
	now := util.NowMillisInt64()
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := upsertUserRecord(tx, payload.ClientID, payload.Nickname, now); err != nil {
			return err
		}
		if err := upsertRoomRecord(tx, roomID, now); err != nil {
			return err
		}
		if err := upsertRoomMemberRecord(tx, roomID, payload.ClientID, payload.Nickname, now); err != nil {
			return err
		}
		return upsertConversationRecord(tx, repository.ConversationRecord{
			ID:        roomConversationID(roomID),
			RoomID:    roomID,
			Type:      conversationTypeRoom,
			Title:     "房间聊天",
			CreatedAt: now,
			UpdatedAt: now,
		})
	})
	if err != nil {
		return protocol.RoomDetail{}, err
	}
	return s.RoomDetail(ctx, roomID, payload.ClientID, nil)
}

func (s *Store) ListRooms(ctx context.Context, userID string) ([]protocol.RoomSummary, error) {
	var memberships []repository.RoomMemberRecord
	if err := s.db.WithContext(ctx).Where("user_id = ?", userID).Order("last_seen_at DESC").Find(&memberships).Error; err != nil {
		return nil, err
	}
	out := make([]protocol.RoomSummary, 0, len(memberships))
	for _, membership := range memberships {
		var room repository.RoomRecord
		if err := s.db.WithContext(ctx).Where("id = ?", membership.RoomID).First(&room).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return nil, err
		}
		summary, err := s.roomSummary(ctx, room, userID)
		if err != nil {
			return nil, err
		}
		out = append(out, summary)
	}
	return out, nil
}

func (s *Store) RoomDetail(ctx context.Context, roomID, viewerID string, online map[string]bool) (protocol.RoomDetail, error) {
	roomID = util.SanitizeRoomID(roomID)
	var room repository.RoomRecord
	if err := s.db.WithContext(ctx).Where("id = ?", roomID).First(&room).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return protocol.RoomDetail{}, ErrNotFound
		}
		return protocol.RoomDetail{}, err
	}
	var members []repository.RoomMemberRecord
	if err := s.db.WithContext(ctx).Where("room_id = ?", roomID).Order("last_seen_at DESC").Find(&members).Error; err != nil {
		return protocol.RoomDetail{}, err
	}
	memberViews := make([]protocol.RoomMemberView, 0, len(members))
	for _, member := range members {
		memberViews = append(memberViews, protocol.RoomMemberView{
			UserID:     member.UserID,
			Nickname:   member.Nickname,
			Role:       member.Role,
			JoinedAt:   member.JoinedAt,
			LastSeenAt: member.LastSeenAt,
			Online:     online != nil && online[member.UserID],
		})
	}
	conversations, err := s.ListConversations(ctx, roomID, viewerID)
	if err != nil {
		return protocol.RoomDetail{}, err
	}
	return protocol.RoomDetail{
		ID:            room.ID,
		DisplayName:   room.DisplayName,
		Members:       memberViews,
		Conversations: conversations,
		UpdatedAt:     room.UpdatedAt,
	}, nil
}

func (s *Store) ListConversations(ctx context.Context, roomID, viewerID string) ([]protocol.ConversationView, error) {
	roomID = util.SanitizeRoomID(roomID)
	var rows []repository.ConversationRecord
	if err := s.db.WithContext(ctx).Where("room_id = ?", roomID).Order("updated_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	views := make([]protocol.ConversationView, 0, len(rows))
	for _, row := range rows {
		if !conversationVisibleTo(row, viewerID) {
			continue
		}
		view, err := s.conversationView(ctx, row, viewerID)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	sort.SliceStable(views, func(i, j int) bool {
		return views[i].UpdatedAt > views[j].UpdatedAt
	})
	return views, nil
}

func (s *Store) CreateDirectConversation(ctx context.Context, roomID string, payload session.Payload, peerUserID string) (protocol.ConversationView, error) {
	roomID = util.SanitizeRoomID(roomID)
	peerUserID = strings.TrimSpace(peerUserID)
	if peerUserID == "" || peerUserID == payload.ClientID {
		return protocol.ConversationView{}, ErrValidation
	}
	now := util.NowMillisInt64()
	row := repository.ConversationRecord{
		ID:         directConversationID(roomID, payload.ClientID, peerUserID),
		RoomID:     roomID,
		Type:       conversationTypeDirect,
		Title:      peerUserID,
		PeerUserID: &peerUserID,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := upsertUserRecord(tx, payload.ClientID, payload.Nickname, now); err != nil {
			return err
		}
		if err := ensureUserRecord(tx, peerUserID, peerUserID, now); err != nil {
			return err
		}
		if err := upsertRoomRecord(tx, roomID, now); err != nil {
			return err
		}
		if err := upsertRoomMemberRecord(tx, roomID, payload.ClientID, payload.Nickname, now); err != nil {
			return err
		}
		return upsertConversationRecord(tx, row)
	})
	if err != nil {
		return protocol.ConversationView{}, err
	}
	return s.conversationView(ctx, row, payload.ClientID)
}

func (s *Store) ListConversationMessages(ctx context.Context, conversationID, viewerID string, limit int, before int64) ([]protocol.MessageView, error) {
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	conversation, err := s.visibleConversation(ctx, conversationID, viewerID)
	if err != nil {
		return nil, err
	}
	var rows []repository.MessageV2Record
	query := s.db.WithContext(ctx).Where("conversation_id = ?", conversation.ID)
	if before > 0 {
		query = query.Where("created_at < ?", before)
	}
	if err := query.Order("created_at DESC, id DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	reverseMessageV2(rows)
	views := make([]protocol.MessageView, 0, len(rows))
	for _, row := range rows {
		view, err := s.messageView(ctx, row)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *Store) CreateConversationMessage(ctx context.Context, conversationID string, payload session.Payload, request protocol.CreateConversationMessageRequest) (protocol.MessageView, error) {
	conversation, err := s.visibleConversation(ctx, conversationID, payload.ClientID)
	if err != nil {
		return protocol.MessageView{}, err
	}
	messageType := request.Type
	if messageType == "" {
		messageType = protocol.MessageTypeText
	}
	text := strings.TrimSpace(request.Text)
	if messageType == protocol.MessageTypeText && text == "" {
		return protocol.MessageView{}, ErrValidation
	}
	if len([]byte(text)) > MaxTextBytes && messageType == protocol.MessageTypeText {
		return protocol.MessageView{}, ErrValidation
	}
	targetID := targetIDForConversation(conversation, payload.ClientID)
	now := util.NowMillisInt64()
	row := repository.MessageV2Record{
		ID:              uuid.NewString(),
		ClientMessageID: request.ClientMessageID,
		RoomID:          conversation.RoomID,
		ConversationID:  conversation.ID,
		SenderID:        payload.ClientID,
		SenderName:      payload.Nickname,
		TargetID:        targetID,
		Type:            string(messageType),
		Text:            optionalText(text),
		Status:          messageStatusSent,
		CreatedAt:       now,
	}
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		summary := summarizeMessageV2(row)
		return tx.Model(&repository.ConversationRecord{}).Where("id = ?", conversation.ID).Updates(map[string]any{
			"last_message_id":   row.ID,
			"last_message_text": summary,
			"last_message_at":   now,
			"updated_at":        now,
		}).Error
	})
	if err != nil {
		return protocol.MessageView{}, err
	}
	return s.messageView(ctx, row)
}

func (s *Store) CreateConversationAttachment(ctx context.Context, conversationID string, payload session.Payload, header *multipart.FileHeader, messageType protocol.MessageType) (protocol.MessageView, error) {
	conversation, err := s.visibleConversation(ctx, conversationID, payload.ClientID)
	if err != nil {
		return protocol.MessageView{}, err
	}
	message, err := s.CreateFileMessage(ctx, conversation.RoomID, payload, header, targetIDForConversation(conversation, payload.ClientID))
	if err != nil {
		return protocol.MessageView{}, err
	}
	if messageType == protocol.MessageTypeTxtFile {
		if err := s.db.WithContext(ctx).Model(&repository.MessageV2Record{}).Where("id = ?", message.ID).Update("type", string(protocol.MessageTypeTxtFile)).Error; err != nil {
			return protocol.MessageView{}, err
		}
	}
	var row repository.MessageV2Record
	if err := s.db.WithContext(ctx).Where("id = ?", message.ID).First(&row).Error; err != nil {
		return protocol.MessageView{}, err
	}
	return s.messageView(ctx, row)
}

func (s *Store) MarkConversationRead(ctx context.Context, conversationID, userID string, request protocol.MarkReadRequest) (protocol.ConversationView, error) {
	conversation, err := s.visibleConversation(ctx, conversationID, userID)
	if err != nil {
		return protocol.ConversationView{}, err
	}
	now := util.NowMillisInt64()
	lastReadAt := request.LastReadAt
	if lastReadAt <= 0 {
		lastReadAt = now
	}
	record := repository.ReadStateRecord{
		ID:                readStateID(conversationID, userID),
		ConversationID:    conversationID,
		UserID:            userID,
		LastReadAt:        lastReadAt,
		LastReadMessageID: request.LastReadMessageID,
		UpdatedAt:         now,
	}
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "conversation_id"}, {Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"last_read_at", "last_read_message_id", "updated_at"}),
	}).Create(&record).Error; err != nil {
		return protocol.ConversationView{}, err
	}
	return s.conversationView(ctx, conversation, userID)
}

func (s *Store) AttachmentInfo(ctx context.Context, attachmentID, viewerID string) (protocol.AttachmentView, error) {
	var attachment repository.AttachmentRecord
	if err := s.db.WithContext(ctx).Where("id = ?", attachmentID).First(&attachment).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return protocol.AttachmentView{}, ErrNotFound
		}
		return protocol.AttachmentView{}, err
	}
	var message repository.MessageV2Record
	if err := s.db.WithContext(ctx).Where("id = ?", attachment.MessageID).First(&message).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return protocol.AttachmentView{}, ErrNotFound
		}
		return protocol.AttachmentView{}, err
	}
	if _, err := s.visibleConversation(ctx, message.ConversationID, viewerID); err != nil {
		return protocol.AttachmentView{}, err
	}
	return attachmentView(attachment), nil
}

func (s *Store) roomSummary(ctx context.Context, room repository.RoomRecord, userID string) (protocol.RoomSummary, error) {
	var conversation repository.ConversationRecord
	err := s.db.WithContext(ctx).Where("room_id = ?", room.ID).Order("last_message_at DESC").First(&conversation).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return protocol.RoomSummary{}, err
	}
	var unread int64
	if err == nil {
		count, countErr := s.unreadCount(ctx, conversation.ID, userID)
		if countErr != nil {
			return protocol.RoomSummary{}, countErr
		}
		unread = count
	}
	return protocol.RoomSummary{
		ID:              room.ID,
		DisplayName:     room.DisplayName,
		LastMessageText: conversation.LastMessageText,
		LastMessageAt:   conversation.LastMessageAt,
		UnreadCount:     unread,
		UpdatedAt:       room.UpdatedAt,
	}, nil
}

func (s *Store) visibleConversation(ctx context.Context, conversationID, viewerID string) (repository.ConversationRecord, error) {
	var conversation repository.ConversationRecord
	err := s.db.WithContext(ctx).Where("id = ?", conversationID).First(&conversation).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return repository.ConversationRecord{}, ErrNotFound
	}
	if err != nil {
		return repository.ConversationRecord{}, err
	}
	if !conversationVisibleTo(conversation, viewerID) {
		return repository.ConversationRecord{}, ErrForbidden
	}
	return conversation, nil
}

func conversationVisibleTo(conversation repository.ConversationRecord, viewerID string) bool {
	if conversation.Type == conversationTypeRoom {
		return true
	}
	if conversation.Type != conversationTypeDirect {
		return false
	}
	return conversationHasUser(conversation.ID, viewerID)
}

func (s *Store) conversationView(ctx context.Context, row repository.ConversationRecord, viewerID string) (protocol.ConversationView, error) {
	title := row.Title
	peerID := peerIDForConversation(row, viewerID)
	if peerID != nil {
		if nickname, ok := s.userNickname(ctx, row.RoomID, *peerID); ok {
			title = nickname
		}
	}
	unread, err := s.unreadCount(ctx, row.ID, viewerID)
	if err != nil {
		return protocol.ConversationView{}, err
	}
	return protocol.ConversationView{
		ID:              row.ID,
		RoomID:          row.RoomID,
		Type:            row.Type,
		Title:           title,
		PeerUserID:      peerID,
		LastMessageID:   row.LastMessageID,
		LastMessageText: row.LastMessageText,
		LastMessageAt:   row.LastMessageAt,
		UnreadCount:     unread,
		UpdatedAt:       row.UpdatedAt,
	}, nil
}

func (s *Store) userNickname(ctx context.Context, roomID, userID string) (string, bool) {
	var user repository.UserRecord
	if err := s.db.WithContext(ctx).Where("id = ?", userID).First(&user).Error; err == nil && strings.TrimSpace(user.Nickname) != "" {
		return user.Nickname, true
	}
	var member repository.RoomMemberRecord
	if err := s.db.WithContext(ctx).Where("room_id = ? AND user_id = ?", roomID, userID).First(&member).Error; err == nil && strings.TrimSpace(member.Nickname) != "" {
		return member.Nickname, true
	}
	return "", false
}

func (s *Store) unreadCount(ctx context.Context, conversationID, userID string) (int64, error) {
	var state repository.ReadStateRecord
	lastReadAt := int64(0)
	if err := s.db.WithContext(ctx).Where("conversation_id = ? AND user_id = ?", conversationID, userID).First(&state).Error; err == nil {
		lastReadAt = state.LastReadAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, err
	}
	var count int64
	err := s.db.WithContext(ctx).Model(&repository.MessageV2Record{}).
		Where("conversation_id = ? AND sender_id <> ? AND created_at > ?", conversationID, userID, lastReadAt).
		Count(&count).Error
	return count, err
}

func (s *Store) messageView(ctx context.Context, row repository.MessageV2Record) (protocol.MessageView, error) {
	var attachment *protocol.AttachmentView
	var attachmentRow repository.AttachmentRecord
	err := s.db.WithContext(ctx).Where("message_id = ?", row.ID).First(&attachmentRow).Error
	if err == nil {
		view := attachmentView(attachmentRow)
		attachment = &view
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return protocol.MessageView{}, err
	}
	return protocol.MessageView{
		ID:              row.ID,
		ClientMessageID: row.ClientMessageID,
		RoomID:          row.RoomID,
		ConversationID:  row.ConversationID,
		Type:            protocol.MessageType(row.Type),
		SenderID:        row.SenderID,
		SenderName:      row.SenderName,
		TargetID:        row.TargetID,
		Text:            row.Text,
		Attachment:      attachment,
		Status:          row.Status,
		CreatedAt:       row.CreatedAt,
	}, nil
}

func (s *Store) mirrorMessageRecord(ctx context.Context, row repository.MessageRecord) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return mirrorMessageRecordInTx(tx, row)
	})
}

func mirrorMessageRecordInTx(tx *gorm.DB, row repository.MessageRecord) error {
	now := row.CreatedAt
	if now <= 0 {
		now = util.NowMillisInt64()
	}
	if err := upsertUserRecord(tx, row.SenderID, row.SenderName, now); err != nil {
		return err
	}
	if row.TargetID != nil {
		if err := ensureUserRecord(tx, *row.TargetID, *row.TargetID, now); err != nil {
			return err
		}
	}
	if err := upsertRoomRecord(tx, row.RoomID, now); err != nil {
		return err
	}
	if err := upsertRoomMemberRecord(tx, row.RoomID, row.SenderID, row.SenderName, now); err != nil {
		return err
	}
	conversation := conversationRecordForLegacy(row)
	if err := upsertConversationRecord(tx, conversation); err != nil {
		return err
	}
	messageType := row.Kind
	if row.FileID != nil && row.ContentType != nil && strings.HasPrefix(strings.ToLower(*row.ContentType), "image/") {
		messageType = string(protocol.MessageTypeImage)
	}
	message := repository.MessageV2Record{
		ID:             row.ID,
		RoomID:         row.RoomID,
		ConversationID: conversation.ID,
		SenderID:       row.SenderID,
		SenderName:     row.SenderName,
		TargetID:       row.TargetID,
		Type:           messageType,
		Text:           row.Text,
		Status:         messageStatusSent,
		CreatedAt:      now,
	}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&message).Error; err != nil {
		return err
	}
	if row.FileID != nil && row.FileName != nil && row.ContentType != nil {
		attachment := repository.AttachmentRecord{
			ID:          *row.FileID,
			MessageID:   row.ID,
			FileName:    *row.FileName,
			Size:        row.FileSize,
			ContentType: *row.ContentType,
			StorageKind: "local",
			StoragePath: row.StoragePath,
			Previewable: util.IsImageContentType(*row.ContentType),
			CreatedAt:   now,
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&attachment).Error; err != nil {
			return err
		}
	}
	summary := summarizeMessageV2(message)
	return tx.Model(&repository.ConversationRecord{}).Where("id = ?", conversation.ID).Updates(map[string]any{
		"last_message_id":   row.ID,
		"last_message_text": summary,
		"last_message_at":   now,
		"updated_at":        now,
	}).Error
}

func upsertUserRecord(tx *gorm.DB, id, nickname string, now int64) error {
	id = strings.TrimSpace(id)
	if id == "" {
		id = "unknown"
	}
	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		nickname = id
	}
	record := repository.UserRecord{ID: id, Nickname: nickname, CreatedAt: now, UpdatedAt: now}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"nickname", "updated_at"}),
	}).Create(&record).Error
}

func ensureUserRecord(tx *gorm.DB, id, nickname string, now int64) error {
	id = strings.TrimSpace(id)
	if id == "" {
		id = "unknown"
	}
	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		nickname = id
	}
	record := repository.UserRecord{ID: id, Nickname: nickname, CreatedAt: now, UpdatedAt: now}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&record).Error
}

func upsertRoomRecord(tx *gorm.DB, roomID string, now int64) error {
	record := repository.RoomRecord{ID: roomID, DisplayName: roomID, CreatedAt: now, UpdatedAt: now}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "updated_at"}),
	}).Create(&record).Error
}

func upsertRoomMemberRecord(tx *gorm.DB, roomID, userID, nickname string, now int64) error {
	record := repository.RoomMemberRecord{
		ID:         roomMemberID(roomID, userID),
		RoomID:     roomID,
		UserID:     userID,
		Nickname:   nickname,
		Role:       "member",
		JoinedAt:   now,
		LastSeenAt: now,
	}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "room_id"}, {Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"nickname", "last_seen_at"}),
	}).Create(&record).Error
}

func upsertConversationRecord(tx *gorm.DB, record repository.ConversationRecord) error {
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"title":        record.Title,
			"peer_user_id": record.PeerUserID,
			"updated_at":   record.UpdatedAt,
		}),
	}).Create(&record).Error
}

func conversationRecordForLegacy(row repository.MessageRecord) repository.ConversationRecord {
	now := row.CreatedAt
	if now <= 0 {
		now = util.NowMillisInt64()
	}
	if row.TargetID == nil || strings.TrimSpace(*row.TargetID) == "" {
		return repository.ConversationRecord{
			ID:        roomConversationID(row.RoomID),
			RoomID:    row.RoomID,
			Type:      conversationTypeRoom,
			Title:     "房间聊天",
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	peerID := strings.TrimSpace(*row.TargetID)
	return repository.ConversationRecord{
		ID:         directConversationID(row.RoomID, row.SenderID, peerID),
		RoomID:     row.RoomID,
		Type:       conversationTypeDirect,
		Title:      peerID,
		PeerUserID: &peerID,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func attachmentView(row repository.AttachmentRecord) protocol.AttachmentView {
	return protocol.AttachmentView{
		ID:          row.ID,
		MessageID:   row.MessageID,
		FileName:    row.FileName,
		Size:        row.Size,
		ContentType: row.ContentType,
		URL:         "/api/files/" + row.ID,
		Previewable: row.Previewable,
		StorageKind: row.StorageKind,
		CreatedAt:   row.CreatedAt,
	}
}

func summarizeMessageV2(row repository.MessageV2Record) string {
	if row.Text != nil && strings.TrimSpace(*row.Text) != "" {
		text := strings.TrimSpace(*row.Text)
		runes := []rune(text)
		if len(runes) > 160 {
			return string(runes[:160])
		}
		return text
	}
	switch protocol.MessageType(row.Type) {
	case protocol.MessageTypeImage:
		return "[图片]"
	case protocol.MessageTypeFile, protocol.MessageTypeTxtFile:
		return "[文件]"
	default:
		return "新消息"
	}
}

func peerIDForConversation(row repository.ConversationRecord, viewerID string) *string {
	if row.Type != conversationTypeDirect {
		return nil
	}
	parts := strings.Split(row.ID, ":")
	if len(parts) < 4 {
		return row.PeerUserID
	}
	left, right := parts[len(parts)-2], parts[len(parts)-1]
	peerID := right
	if viewerID == right {
		peerID = left
	}
	return &peerID
}

func targetIDForConversation(row repository.ConversationRecord, senderID string) *string {
	return peerIDForConversation(row, senderID)
}

func conversationHasUser(conversationID, userID string) bool {
	parts := strings.Split(conversationID, ":")
	if len(parts) < 4 {
		return false
	}
	return parts[len(parts)-2] == userID || parts[len(parts)-1] == userID
}

func roomConversationID(roomID string) string {
	return "room:" + roomID
}

func directConversationID(roomID, left, right string) string {
	ids := []string{strings.TrimSpace(left), strings.TrimSpace(right)}
	sort.Strings(ids)
	return "direct:" + roomID + ":" + ids[0] + ":" + ids[1]
}

func roomMemberID(roomID, userID string) string {
	return roomID + ":" + userID
}

func readStateID(conversationID, userID string) string {
	return conversationID + ":" + userID
}

func optionalText(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

func reverseMessageV2(rows []repository.MessageV2Record) {
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
}
