import { PlatformBackend } from './platform.backend.js';
import type { AgentSpecView } from '../../../domain/ports/framework-adapter.port.js';

const emptySpec = (): AgentSpecView =>
  ({
    skills: [],
    recalled: [],
    knowledge: [],
  }) as unknown as AgentSpecView;

/**
 * `downloadFiles`/`uploadFiles` are optional in `BackendProtocolV2`, so a `PlatformBackend`
 * missing them compiles fine standalone -- the gap only bites once it sits behind a
 * `CompositeBackend`. `CompositeBackend` unconditionally exposes its OWN `downloadFiles`
 * method regardless of what its routes support, so any framework code that duck-types
 * `if (backend.downloadFiles)` sees one on the composite and calls it -- which then throws
 * "Backend does not support downloadFiles" for any path that resolves to a route lacking
 * the method. `listSkillsFromBackend` swallows that into a `console.debug` and returns no
 * skills, which is how a full skill went silently missing from a sub-agent's prompt with no
 * error anywhere. Implementing both here is what closes the gap for every consumer that
 * duck-types this way, not just the one that happened to surface it first.
 */
describe('PlatformBackend.downloadFiles / uploadFiles', () => {
  describe('downloadFiles', () => {
    it('returns the bytes of a file that was seeded (e.g. a skill)', async () => {
      const backend = new PlatformBackend(emptySpec());
      backend.write('/scratch.txt', 'hello');

      const [result] = await backend.downloadFiles(['/scratch.txt']);

      expect(result!.error).toBeNull();
      expect(Buffer.from(result!.content!).toString('utf8')).toBe('hello');
      expect(result!.path).toBe('/scratch.txt');
    });

    it('reports file_not_found for a path nothing was ever written to', async () => {
      const backend = new PlatformBackend(emptySpec());

      const [result] = await backend.downloadFiles(['/nope.txt']);

      expect(result!.content).toBeNull();
      expect(result!.error).toBe('file_not_found');
    });

    it('handles a batch of paths, matching results to inputs positionally', async () => {
      const backend = new PlatformBackend(emptySpec());
      backend.write('/a.txt', 'A');
      backend.write('/b.txt', 'B');

      const results = await backend.downloadFiles(['/a.txt', '/missing.txt', '/b.txt']);

      expect(Buffer.from(results[0]!.content!).toString('utf8')).toBe('A');
      expect(results[1]!.error).toBe('file_not_found');
      expect(Buffer.from(results[2]!.content!).toString('utf8')).toBe('B');
    });
  });

  describe('uploadFiles', () => {
    it('writes bytes that downloadFiles then returns unchanged', async () => {
      const backend = new PlatformBackend(emptySpec());

      const [result] = await backend.uploadFiles([['/new.txt', Buffer.from('uploaded', 'utf8')]]);

      expect(result!.error).toBeNull();
      const [downloaded] = await backend.downloadFiles(['/new.txt']);
      expect(Buffer.from(downloaded!.content!).toString('utf8')).toBe('uploaded');
    });

    it('refuses to overwrite a read-only (e.g. recalled memory) path', async () => {
      // Not /skills/*: that content moved off this class entirely (see
      // deep-agents.adapter.ts's CompositeBackend routing and ReadOnlyStore), which is
      // what owns skill read-only-ness now. /memory/* is still seeded here directly.
      const backend = new PlatformBackend({
        ...emptySpec(),
        recalled: [{ tier: 'semantic', content: 'x', provenance: 'run:1', trusted: true, score: 1 }],
      } as AgentSpecView);

      const [result] = await backend.uploadFiles([
        ['/memory/semantic.md', Buffer.from('overwritten', 'utf8')],
      ]);

      expect(result!.error).toBe('permission_denied');
    });
  });
});
