import { describe, expect, it } from 'vitest';
import {
  buildHttpRequest,
  HttpToolShapeError,
  type HttpToolShape,
} from '../src/domain/tool-runtime/http-request.js';

const shape = (over: Partial<HttpToolShape> = {}): HttpToolShape => ({
  endpointUrl: 'https://api.github.com',
  method: 'GET',
  pathTemplate: null,
  argPlacement: null,
  staticHeaders: {},
  ...over,
});

describe('registered HTTP request shapes (§8.1)', () => {
  it('builds the GitHub diff call from a template', () => {
    const built = buildHttpRequest(
      shape({ pathTemplate: '/repos/{owner}/{repo}/pulls/{number}/files' }),
      { owner: 'cashfree-tech', repo: 'payments', number: 42 },
    );
    expect(built.url).toBe('https://api.github.com/repos/cashfree-tech/payments/pulls/42/files');
    expect(built.method).toBe('GET');
    expect(built.body).toBeNull();
  });

  it('sends leftover arguments as query on GET and as a body on POST', () => {
    const get = buildHttpRequest(
      shape({ pathTemplate: '/repos/{owner}/{repo}/contents/{+path}' }),
      { owner: 'o', repo: 'r', path: 'src/main.ts', ref: 'main' },
    );
    expect(get.url).toContain('?ref=main');

    const post = buildHttpRequest(
      shape({ method: 'POST', pathTemplate: '/repos/{owner}/{repo}/pulls/{n}/reviews' }),
      { owner: 'o', repo: 'r', n: 7, event: 'COMMENT', body: 'looks fine' },
    );
    // Path arguments are consumed; only the rest reach the body.
    expect(JSON.parse(post.body!)).toEqual({ event: 'COMMENT', body: 'looks fine' });
    expect(post.headers['content-type']).toBe('application/json');
  });

  it('keeps slashes only where the template asked for them', () => {
    const reserved = buildHttpRequest(
      shape({ pathTemplate: '/repos/{owner}/{repo}/contents/{+path}' }),
      { owner: 'o', repo: 'r', path: 'src/deep/file.ts' },
    );
    expect(reserved.url).toBe('https://api.github.com/repos/o/r/contents/src/deep/file.ts');

    // Plain expansion is ONE segment: a slash is encoded, so a value cannot invent a
    // path segment the template never declared.
    const plain = buildHttpRequest(shape({ pathTemplate: '/repos/{owner}/x' }), {
      owner: 'o/../../admin',
    });
    expect(plain.url).toBe('https://api.github.com/repos/o%2F..%2F..%2Fadmin/x');
  });

  it('refuses traversal even where slashes are allowed', () => {
    // `{+path}` exists so file paths work; it is not a licence to climb out of the prefix.
    expect(() =>
      buildHttpRequest(shape({ pathTemplate: '/repos/{owner}/contents/{+path}' }), {
        owner: 'o',
        path: '../../../admin/secrets',
      }),
    ).toThrow(HttpToolShapeError);
  });

  it('refuses an argument that would move the request to another origin', () => {
    // The guard that makes the rest safe: whatever the mechanism, if the resolved URL
    // does not belong to the registered origin, it is not sent.
    const attempts = ['https://evil.example/x', '//evil.example/x', 'http://169.254.169.254/'];
    for (const owner of attempts) {
      const built = buildHttpRequest(shape({ pathTemplate: '/repos/{owner}' }), { owner });
      expect(new URL(built.url).origin).toBe('https://api.github.com');
    }
  });

  it('will not let a template escape the endpoint prefix', () => {
    // A leading slash on the template must not reset the path to the host root, or a tool
    // registered against /v3/ could reach /admin/.
    const built = buildHttpRequest(
      shape({ endpointUrl: 'https://api.example.com/v3', pathTemplate: '/things/{id}' }),
      { id: 9 },
    );
    expect(built.url).toBe('https://api.example.com/v3/things/9');
  });

  it('rejects a non-http scheme on the endpoint', () => {
    for (const endpointUrl of ['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi']) {
      expect(() => buildHttpRequest(shape({ endpointUrl }), {})).toThrow(HttpToolShapeError);
    }
  });

  it('names a missing path argument instead of sending a literal placeholder', () => {
    // The alternative is a request to /repos/%7Bowner%7D, which 404s and looks like the
    // remote being wrong rather than the call being malformed.
    expect(() =>
      buildHttpRequest(shape({ pathTemplate: '/repos/{owner}' }), {}),
    ).toThrow(/needs argument "owner"/);
  });

  it('refuses a structured value where only a scalar can go', () => {
    for (const args of [{ owner: { a: 1 } }, { owner: ['a'] }]) {
      expect(() =>
        buildHttpRequest(shape({ pathTemplate: '/repos/{owner}' }), args),
      ).toThrow(HttpToolShapeError);
    }
    // Same for query, where no single encoding is obviously right.
    expect(() =>
      buildHttpRequest(shape({ method: 'GET' }), { filter: { a: 1 } }),
    ).toThrow(HttpToolShapeError);
  });

  it('preserves the pre-0016 default when no shape is registered', () => {
    // Every tool registered before this migration keeps working: POST to the endpoint
    // with the arguments as a JSON body.
    const built = buildHttpRequest(
      shape({ endpointUrl: 'https://tools.internal/echo', method: 'POST', argPlacement: 'body' }),
      { echo: 'hi' },
    );
    expect(built.url).toBe('https://tools.internal/echo');
    expect(JSON.parse(built.body!)).toEqual({ echo: 'hi' });
  });

  it('sends nothing extra when placement is none', () => {
    const built = buildHttpRequest(
      shape({ method: 'POST', pathTemplate: '/x/{id}', argPlacement: 'none' }),
      { id: 1, secret: 'must not travel' },
    );
    expect(built.body).toBeNull();
    expect(built.url).toBe('https://api.github.com/x/1');
  });
});
