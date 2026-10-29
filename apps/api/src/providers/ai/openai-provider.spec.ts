import { useHermeticEnv } from '../../../test/hermetic-env';
import { AiOutputError, AiRequest, AiUnavailableError, OpenAiProvider } from './ai';

// OpenAiProvider against a mocked fetch: no network, no real key, no .env (hermetic environment). Any fetch a test did not
// explicitly mock throws, so a forgotten mock fails the test instead of reaching api.openai.com.
const API_KEY = 'sk-unit-test-not-a-real-key';
useHermeticEnv({
  DATABASE_URL: 'x', SESSION_SECRET: 'unit-test-session-secret-0123456789', APP_ENCRYPTION_KEY: 'unit-test-encryption-key-0123456789',
  AI_PROVIDER: 'openai', AI_API_KEY: API_KEY, AI_MODEL: 'test-model-1', AI_TIMEOUT_MS: '5000',
});

let fetchMock: jest.SpyInstance;
beforeEach(() => { fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => { throw new Error('unexpected real network call'); }); });
afterEach(() => fetchMock.mockRestore());

const http = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (content: unknown, choice: Record<string, unknown> = {}, usage: unknown = { prompt_tokens: 120, completion_tokens: 40 }) =>
  ({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...choice }], usage });
const REQ: AiRequest = { feature: 'summary', system: 'SYSTEM PROMPT TEXT', input: { messages: [{ from: 'customer', text: 'Need a cab to Coorg' }], vehicleTypes: ['Innova'] } };
const run = () => new OpenAiProvider().generate(REQ);
const failure = async () => run().then(() => { throw new Error('expected generate() to fail'); }, (e: Error) => e);
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('OpenAiProvider: a good answer', () => {
  it('returns the parsed JSON object with token usage and the configured model', async () => {
    fetchMock.mockResolvedValueOnce(http(200, completion(JSON.stringify({ summary: 'ok', openQuestions: [] }))));
    const r = await run();
    expect(r).toEqual({ output: { summary: 'ok', openQuestions: [] }, inputTokens: 120, outputTokens: 40, model: 'test-model-1' });
  });

  it('sends JSON mode, the feature prompt as system message, and the conversation as untrusted JSON data', async () => {
    fetchMock.mockResolvedValueOnce(http(200, completion('{}')));
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.signal).toBeDefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model-1');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SYSTEM PROMPT TEXT');
    expect(body.messages[0].content).toMatch(/untrusted data/i);
    expect(body.messages[0].content).toMatch(/single JSON object/i);
    expect(body.messages[1].role).toBe('user');
    expect(JSON.parse(body.messages[1].content)).toEqual({ feature: 'summary', messages: [{ from: 'customer', text: 'Need a cab to Coorg' }], vehicleTypes: ['Innova'] });
    expect(body.messages[1].content).not.toContain('SYSTEM PROMPT TEXT');
  });

  it('reports zero tokens when the provider sends no usage block', async () => {
    const body: Record<string, unknown> = completion('{"a":1}');
    delete body.usage;
    fetchMock.mockResolvedValueOnce(http(200, body));
    expect(await run()).toMatchObject({ output: { a: 1 }, inputTokens: 0, outputTokens: 0 });
  });

  it('ignores nonsense usage values instead of propagating them', async () => {
    fetchMock.mockResolvedValueOnce(http(200, completion('{"a":1}', {}, { prompt_tokens: 'many', completion_tokens: -5 })));
    expect(await run()).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('OpenAiProvider: answers that cannot be used raise AiOutputError (the call was billed, so usage is attached)', () => {
  it.each([
    ['malformed JSON', '{"summary": "cut off', 'malformed_json'],
    ['JSON wrapped in a markdown fence', '```json\n{"summary":"x"}\n```', 'malformed_json'],
    ['plain prose', 'Sure! Here is a summary of the chat.', 'malformed_json'],
    ['a JSON array', '[1,2,3]', 'not_an_object'],
    ['a JSON string', '"hello"', 'not_an_object'],
    ['a JSON number', '42', 'not_an_object'],
    ['JSON null', 'null', 'not_an_object'],
    ['an empty string', '', 'empty_content'],
    ['whitespace only', '   \n ', 'empty_content'],
  ])('%s', async (_label, content, problem) => {
    fetchMock.mockResolvedValueOnce(http(200, completion(content)));
    const e = await failure();
    expect(e).toBeInstanceOf(AiOutputError);
    expect((e as AiOutputError).problem).toBe(problem);
    expect((e as AiOutputError).usage).toEqual({ inputTokens: 120, outputTokens: 40, model: 'test-model-1' });
    if (content.trim()) expect(e.message).not.toContain(content.slice(0, 12)); // the model's text is never echoed into errors
  });

  it('missing, null or non-string message content -> empty_content (including a refusal)', async () => {
    for (const body of [
      { choices: [{ message: { role: 'assistant' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help with that' }, finish_reason: 'stop' }] },
      { choices: [{ message: { role: 'assistant', content: { not: 'a string' } }, finish_reason: 'stop' }] },
      { choices: [{ finish_reason: 'stop' }] },
    ]) {
      fetchMock.mockResolvedValueOnce(http(200, body));
      const e = await failure();
      expect(e).toBeInstanceOf(AiOutputError);
      expect((e as AiOutputError).problem).toBe('empty_content');
    }
  });

  it('an answer cut off by the output limit is rejected even if the fragment happens to be valid JSON', async () => {
    fetchMock.mockResolvedValueOnce(http(200, completion('{"summary":"complete-looking"}', { finish_reason: 'length' })));
    const e = await failure();
    expect(e).toBeInstanceOf(AiOutputError);
    expect((e as AiOutputError).problem).toBe('truncated');
  });

  it('an answer removed by the provider content filter is rejected', async () => {
    fetchMock.mockResolvedValueOnce(http(200, completion('', { finish_reason: 'content_filter' })));
    const e = await failure();
    expect(e).toBeInstanceOf(AiOutputError);
    expect((e as AiOutputError).problem).toBe('content_filtered');
  });

  it.each([
    ['no choices array', { usage: { prompt_tokens: 5, completion_tokens: 1 } }],
    ['an empty choices array', { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }],
    ['choices that is not an array', { choices: 'nope' }],
    ['a first choice that is not an object', { choices: ['text'] }],
    ['a body that is a JSON string', 'just a string'],
    ['a body that is JSON null', null],
  ])('unexpected response structure (%s) -> provider_response_unreadable', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(http(200, JSON.stringify(body)));
    const e = await failure();
    expect(e).toBeInstanceOf(AiOutputError);
    expect((e as AiOutputError).problem).toBe('provider_response_unreadable');
  });

  it('an HTML or non-JSON HTTP body -> provider_response_unreadable', async () => {
    fetchMock.mockResolvedValueOnce(http(200, '<html><body>Bad gateway</body></html>'));
    const e = await failure();
    expect(e).toBeInstanceOf(AiOutputError);
    expect((e as AiOutputError).problem).toBe('provider_response_unreadable');
  });
});

describe('OpenAiProvider: the provider could not be used at all -> AiUnavailableError', () => {
  it.each([401, 429, 500, 503])('HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(http(status, { error: { message: 'details the user must never see', type: 'x' } }));
    const e = await failure();
    expect(e).toBeInstanceOf(AiUnavailableError);
    expect(e).not.toBeInstanceOf(AiOutputError);
    expect(e.message).toBe(`AI provider returned ${status}`);
  });

  it('a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNRESET'));
    const e = await failure();
    expect(e).toBeInstanceOf(AiUnavailableError);
    expect(e.message).toContain('ECONNRESET');
  });

  it('a timeout while waiting for the response', async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    expect(await failure()).toBeInstanceOf(AiUnavailableError);
  });

  it('a timeout while reading the response body is unavailable, not a bad answer', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw timeoutError(); } } as unknown as Response);
    const e = await failure();
    expect(e).toBeInstanceOf(AiUnavailableError);
    expect(e).not.toBeInstanceOf(AiOutputError);
  });

  it('never puts the API key into an error message', async () => {
    const errors: Error[] = [];
    for (const mock of [
      () => fetchMock.mockResolvedValueOnce(http(401, { error: 'bad key' })),
      () => fetchMock.mockRejectedValueOnce(new Error('network down')),
      () => fetchMock.mockResolvedValueOnce(http(200, completion('not json'))),
    ]) { mock(); errors.push(await failure()); }
    for (const e of errors) expect(e.message).not.toContain(API_KEY);
  });
});
