package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/baisuipingan/patrick-im/backend/server/internal/chat"
	"github.com/baisuipingan/patrick-im/backend/server/internal/config"
	"github.com/baisuipingan/patrick-im/backend/server/internal/httpapi"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.FromEnv()
	if err != nil {
		logger.Error("load config failed", "error", err)
		os.Exit(1)
	}

	db, err := repository.OpenSQLite(cfg.SQLitePath)
	if err != nil {
		logger.Error("open sqlite failed", "error", err)
		os.Exit(1)
	}
	sqlDB, err := db.DB()
	if err != nil {
		logger.Error("read sqlite handle failed", "error", err)
		os.Exit(1)
	}
	defer sqlDB.Close()

	store, err := chat.NewStore(db, cfg.FileStorePath, cfg.UploadLimitBytes)
	if err != nil {
		logger.Error("open chat store failed", "error", err)
		os.Exit(1)
	}

	api := httpapi.New(
		cfg,
		logger,
		store,
		chat.NewHub(),
	)
	router := httpapi.Router(api)
	server := &http.Server{
		Addr:              cfg.Bind,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("starting patrick-im gin server", "bind", cfg.Bind, "sqlite", cfg.SQLitePath)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}
