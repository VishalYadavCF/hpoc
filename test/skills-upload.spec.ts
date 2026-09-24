const API = 'http://localhost:3000';
const H = () => ({
  'x-caller-subject': 'svc:demo-client',
  'x-namespace': 'demo',
  'x-tenant-ref': 'merchant-1',
});

const SUFFIX = Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  if (!(await fetch(`${API}/healthz`).catch(() => null))?.ok) {
    throw new Error('api must be running');
  }
});

describe('POST /v1/skills/upload', () => {
  it('publishes a skill from an uploaded file', async () => {
    const form = new FormData();
    form.set('name', `http-upload-${SUFFIX}`);
    form.set('whenToUse', 'when testing the upload endpoint');
    form.set('file', new Blob(['---\nname: x\n---\n\nuploaded body'], { type: 'text/markdown' }), 'SKILL.md');

    const res = await fetch(`${API}/v1/skills/upload`, { method: 'POST', headers: H(), body: form });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { skillId: string; skillVersionId: string; version: number };
    expect(body.skillVersionId).toBeTruthy();
    expect(body.version).toBe(1);
  });

  it('rejects an upload with no file, naming the missing field', async () => {
    const form = new FormData();
    form.set('name', `no-file-${SUFFIX}`);

    const res = await fetch(`${API}/v1/skills/upload`, { method: 'POST', headers: H(), body: form });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.join()).toMatch(/file/i);
  });

  it('rejects an upload with no name', async () => {
    const form = new FormData();
    form.set('file', new Blob(['content'], { type: 'text/markdown' }), 'SKILL.md');

    const res = await fetch(`${API}/v1/skills/upload`, { method: 'POST', headers: H(), body: form });

    expect(res.status).toBe(422);
  });

  it('rejects tools/collections that are not valid JSON', async () => {
    const form = new FormData();
    form.set('name', `bad-tools-${SUFFIX}`);
    form.set('tools', 'not-json');
    form.set('file', new Blob(['content'], { type: 'text/markdown' }), 'SKILL.md');

    const res = await fetch(`${API}/v1/skills/upload`, { method: 'POST', headers: H(), body: form });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.join()).toMatch(/tools/i);
  });

  it('an uploaded skill shows up in the namespace skill list', async () => {
    const name = `http-listed-${SUFFIX}`;
    const form = new FormData();
    form.set('name', name);
    form.set('file', new Blob(['---\nname: x\n---\n\nbody'], { type: 'text/markdown' }), 'SKILL.md');
    const published = await fetch(`${API}/v1/skills/upload`, { method: 'POST', headers: H(), body: form });
    expect(published.status).toBe(201);

    const res = await fetch(`${API}/v1/skills`, { headers: H() });
    const body = (await res.json()) as { skills: { name: string }[] };
    expect(body.skills.map((s) => s.name)).toContain(name);
  });
});
