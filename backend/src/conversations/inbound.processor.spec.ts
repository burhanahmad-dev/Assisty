import 'reflect-metadata';
import { InboundProcessor, FALLBACK_REPLY } from './inbound.processor';

/**
 * Deterministic, infra-free proof of the core conversation pipeline. All
 * collaborators are mocked, so this verifies the BEHAVIOR the product depends
 * on: every message persisted, a graceful fallback when the AI fails, and a
 * rethrow (=> pg-boss retry) when delivery fails.
 */
describe('InboundProcessor (core loop behaviour)', () => {
  const job = {
    id: 'job-1',
    data: {
      tenantId: 't1',
      channelConnectionId: 'cc1',
      channelType: 'whatsapp' as const,
      customerExternalId: '15559998888',
      channelMessageId: 'wamid.TEST.1',
      text: 'Hello, what are your hours?',
    },
  };

  function build() {
    const conversations = {
      findOrCreate: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    };
    const messages = {
      insertInbound: jest.fn().mockResolvedValue(null),
      insertOutbound: jest.fn().mockResolvedValue({ id: 'out-1' }),
      recentByConversation: jest.fn().mockResolvedValue([]),
      existsByChannelMessageId: jest.fn().mockResolvedValue(false),
    };
    const rag = {
      retrieve: jest.fn().mockResolvedValue([]),
      buildContextBlock: jest.fn().mockReturnValue(''),
    };
    const ai = {
      chat: jest
        .fn()
        .mockResolvedValue({ content: 'We are open 9-5.', model: 'free-model', usageTokens: 12 }),
    };
    const whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
    const channelConnections = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'cc1', tenantId: 't1', accessToken: null, phoneNumberId: 'pn1' }),
    };
    const usage = { record: jest.fn().mockResolvedValue(undefined) };
    const queue = { work: jest.fn() };

    const proc = new InboundProcessor(
      queue as never,
      ai as never,
      rag as never,
      whatsapp as never,
      conversations as never,
      messages as never,
      channelConnections as never,
      usage as never,
    );

    // handle() is private; invoke it directly for a focused unit test.
    const run = (j = job) => (proc as unknown as { handle: (j: unknown) => Promise<void> }).handle(j);

    return { proc, run, conversations, messages, rag, ai, whatsapp, channelConnections, usage };
  }

  it('persists inbound + outbound and sends the AI reply (happy path)', async () => {
    const t = build();
    await t.run();

    expect(t.messages.insertInbound).toHaveBeenCalledWith(
      expect.objectContaining({ channelMessageId: 'wamid.TEST.1', content: job.data.text }),
    );
    expect(t.ai.chat).toHaveBeenCalledTimes(1);
    expect(t.messages.insertOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'We are open 9-5.', model: 'free-model', tokens: 12 }),
    );
    expect(t.whatsapp.sendText).toHaveBeenCalledWith(
      expect.anything(),
      '15559998888',
      'We are open 9-5.',
    );
    expect(t.usage.record).toHaveBeenCalledTimes(2);
  });

  it('replies with a graceful fallback when the AI fails (no throw)', async () => {
    const t = build();
    t.ai.chat.mockRejectedValueOnce(new Error('model unavailable'));

    await expect(t.run()).resolves.toBeUndefined();

    expect(t.messages.insertInbound).toHaveBeenCalled();
    expect(t.messages.insertOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: FALLBACK_REPLY }),
    );
    expect(t.whatsapp.sendText).toHaveBeenCalledWith(
      expect.anything(),
      '15559998888',
      FALLBACK_REPLY,
    );
  });

  it('treats an empty AI completion as a fallback', async () => {
    const t = build();
    t.ai.chat.mockResolvedValueOnce({ content: '   ', model: 'free-model', usageTokens: 0 });

    await expect(t.run()).resolves.toBeUndefined();

    expect(t.messages.insertOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: FALLBACK_REPLY }),
    );
  });

  it('rethrows when delivery fails so pg-boss retries (and still persisted both messages)', async () => {
    const t = build();
    t.whatsapp.sendText.mockRejectedValueOnce(new Error('whatsapp 503'));

    await expect(t.run()).rejects.toThrow('whatsapp 503');

    expect(t.messages.insertInbound).toHaveBeenCalled();
    expect(t.messages.insertOutbound).toHaveBeenCalled();
  });

  it('does not let a usage-ledger failure break a delivered reply', async () => {
    const t = build();
    t.usage.record.mockRejectedValue(new Error('ledger down'));

    await expect(t.run()).resolves.toBeUndefined();

    expect(t.whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});
