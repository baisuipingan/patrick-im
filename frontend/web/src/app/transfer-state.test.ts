import { describe, expect, it } from 'vitest';
import { reduceTransferUpdate } from '@/app/transfer-state';
import type { TransferRow } from '@/app/types';

describe('transfer-state', () => {
  it('closes completed transfers and emits direct success notice', () => {
    const result = reduceTransferUpdate({
      activeTransferNoticeId: 'tx-1',
      closedTransferIds: new Set<string>(),
      currentTransfers: {
        'tx-1': {
          id: 'tx-1',
          transferId: 'tx-1',
          direction: 'upload',
          transport: 'direct-p2p',
          peerId: 'peer-1',
          peerName: 'Peer',
          fileName: 'a.txt',
          totalBytes: 10,
          transferredBytes: 10,
          status: 'streaming',
          startedAt: 1,
        } satisfies TransferRow,
      },
      getPeerDisplayName: () => 'Peer',
      update: {
        transferId: 'tx-1',
        direction: 'upload',
        transport: 'direct-p2p',
        peerId: 'peer-1',
        peerName: 'Peer',
        fileName: 'a.txt',
        totalBytes: 10,
        transferredBytes: 10,
        status: 'complete',
      },
    });

    expect(result.noticeMessage).toContain('已直连发送给 Peer');
    expect(result.resetActiveTransferNotice).toBe(true);
    expect(result.nextTransfers).toEqual({});
    expect(result.closedTransferIds.has('tx-1')).toBe(true);
  });

  it('ignores non-terminal updates after transfer is already closed', () => {
    const result = reduceTransferUpdate({
      activeTransferNoticeId: null,
      closedTransferIds: new Set<string>(['tx-1']),
      currentTransfers: {},
      getPeerDisplayName: () => 'Peer',
      update: {
        transferId: 'tx-1',
        direction: 'upload',
        transport: 'server-relay',
        peerId: 'peer-1',
        peerName: 'Peer',
        fileName: 'a.txt',
        totalBytes: 10,
        transferredBytes: 5,
        status: 'streaming',
      },
    });

    expect(result.nextTransfers).toBeNull();
  });

  it('updates transfer row speed snapshot while streaming', () => {
    const now = Date.now();
    const result = reduceTransferUpdate({
      activeTransferNoticeId: null,
      closedTransferIds: new Set<string>(),
      currentTransfers: {
        'tx-1': {
          id: 'tx-1',
          transferId: 'tx-1',
          direction: 'upload',
          transport: 'server-relay',
          peerId: 'peer-1',
          peerName: 'Peer',
          fileName: 'a.txt',
          totalBytes: 100,
          transferredBytes: 20,
          status: 'streaming',
          startedAt: now - 1000,
          lastProgressAt: now - 500,
          lastProgressBytes: 20,
        } satisfies TransferRow,
      },
      getPeerDisplayName: () => 'Peer',
      update: {
        transferId: 'tx-1',
        direction: 'upload',
        transport: 'server-relay',
        peerId: 'peer-1',
        peerName: 'Peer',
        fileName: 'a.txt',
        totalBytes: 100,
        transferredBytes: 80,
        status: 'streaming',
      },
    });

    expect(result.nextTransfers?.['tx-1'].transferredBytes).toBe(80);
  });
});
