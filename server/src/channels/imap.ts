import { ImapFlow } from 'imapflow';

/*
 * The IMAP side of email channels (B-2303). The channel service polls through `ImapFetcher`, an interface small enough
 * to fake in tests; the default implementation uses imapflow. A poll opens the mailbox read-only (nothing is marked or
 * moved: the cursor is the last UID seen, kept per channel with the mailbox's UIDVALIDITY), reads the messages above
 * the cursor, oldest first, up to a batch, and logs out. The caller checked the host against the service address rules
 * and passes the address to dial, with the name for TLS.
 */

export interface ImapTarget {
  /** The address to connect to (already checked). */
  address: string;
  /** The configured host name, for TLS server name verification. */
  servername: string;
  port: number;
  /** Implicit TLS (993); otherwise STARTTLS, which is required. */
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

export interface ImapCursor {
  uidValidity: number | null;
  lastUid: number;
}

export interface ImapBatch {
  uidValidity: number;
  messages: { uid: number; raw: Buffer }[];
  /** More messages wait above the batch. */
  more: boolean;
}

export type ImapFetcher = (target: ImapTarget, cursor: ImapCursor, max: number, signal?: AbortSignal) => Promise<ImapBatch>;

/** Messages larger than this are skipped (and counted) rather than read. */
export const IMAP_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

export const imapflowFetcher: ImapFetcher = async (t, cursor, max, signal) => {
  const client = new ImapFlow({
    host: t.address,
    servername: t.servername,
    port: t.port,
    secure: t.secure,
    // Without implicit TLS the connection must upgrade: credentials never cross in clear.
    ...(t.secure ? {} : { doSTARTTLS: true }),
    auth: { user: t.user, pass: t.pass },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    maxLiteralSize: IMAP_MAX_MESSAGE_BYTES + 1024 * 1024,
    clientInfo: { name: 'exprsn-ai' }
  });
  const abort = () => void client.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    const box = await client.mailboxOpen(t.mailbox, { readOnly: true });
    const uidValidity = Number(box.uidValidity);
    // A new UIDVALIDITY means the old UIDs mean nothing: read from the start (Message-IDs deduplicate).
    const from = cursor.uidValidity === uidValidity ? cursor.lastUid : 0;
    const messages: { uid: number; raw: Buffer }[] = [];
    let more = false;
    if (box.exists > 0) {
      for await (const m of client.fetch(`${from + 1}:*`, { uid: true, size: true, source: true }, { uid: true })) {
        // `n:*` always answers the newest message, even when it is below n.
        if (m.uid <= from) continue;
        if (messages.length >= max) {
          more = true;
          continue;
        }
        if (!m.source || (m.size ?? m.source.length) > IMAP_MAX_MESSAGE_BYTES) {
          messages.push({ uid: m.uid, raw: Buffer.alloc(0) });
          continue;
        }
        messages.push({ uid: m.uid, raw: m.source });
      }
    }
    messages.sort((a, b) => a.uid - b.uid);
    await client.logout();
    return { uidValidity, messages, more };
  } finally {
    signal?.removeEventListener('abort', abort);
    client.close();
  }
};
