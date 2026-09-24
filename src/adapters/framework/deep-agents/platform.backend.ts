import type {
  BackendProtocolV2,
  DeleteResult,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from 'deepagents';
import type {
  AgentSpecView,
  RecalledMemory,
  SkillHandle,
} from '../../../domain/ports/framework-adapter.port.js';
import { PlatformError } from '../../../domain/errors/platform.errors.js';

/**
 * The platform's resolved context, projected as a filesystem DeepAgents can read.
 *
 * ## Why a filesystem at all
 *
 * `createSkillsMiddleware` and `createMemoryMiddleware` are written against a backend, and
 * a backend is a virtual filesystem. That looks like an awkward fit for rows in Postgres
 * until you notice what it buys: **progressive disclosure**. The skills middleware puts
 * each skill's NAME and DESCRIPTION in the system prompt and lets the model read the body
 * only if it decides the skill applies.
 *
 * The old behaviour was to concatenate every pinned skill's full instructions into the
 * prompt on every step. With twelve skills that is twelve procedures the model must hold
 * and rank on every turn, most of them irrelevant.
 *
 * ## What does NOT move
 *
 * Versioning, approval gates, tenant scoping and provenance all stay above this line. The
 * projection contains only what the platform ALREADY decided this run may see: the skills
 * pinned to the resolved agent version, and the memory recall returned under this tenant's
 * policy. A model cannot read a skill into existence by guessing a path, because nothing
 * that was not resolved is here to read.
 *
 * ## Layout
 *
 * ```
 *   /memory/<tier>.md            one per recalled memory tier
 *   /knowledge/retrieved.md      what knowledge search returned this run
 *   /workspace/...               scratch, MinIO-backed (see deep-agents.adapter.ts)
 * ```
 *
 * `/skills/` is deliberately NOT projected here. It routes to a MinIO-backed `StoreBackend`
 * the same way `/workspace` does -- see `deep-agents.adapter.ts`'s `CompositeBackend`
 * wiring -- because a skill's body is now read on demand from wherever it actually lives
 * (a JSON-authored row rendered fresh, or an uploaded file streamed from object storage),
 * not eagerly concatenated into an in-memory map at construction time. This class keeps
 * only enough about skills to answer `skillPath`/`skillSources` (see below) -- the names,
 * not the bodies.
 *
 * ## Honest limit
 *
 * `/workspace` writes are durable (§11.2); `/memory` and `/knowledge` are not, and are not
 * meant to be -- both are resolved fresh from Postgres every run, so re-seeding them on
 * resume is correct, not a gap.
 */
export class PlatformBackend implements BackendProtocolV2 {
  private readonly files = new Map<string, string>();
  /** Paths the platform owns. Refusing writes here keeps the projection honest. */
  private readonly readOnly = new Set<string>();
  private readonly skillNames: Set<string>;

  constructor(spec: AgentSpecView) {
    this.skillNames = new Set(spec.skills.map((s) => slug(s.name)));
    for (const [tier, records] of groupByTier(spec.recalled)) {
      this.seed(`/memory/${slug(tier)}.md`, memoryDocument(tier, records));
    }
    if (spec.knowledge.length > 0) {
      this.seed(
        '/knowledge/retrieved.md',
        '# Reference material retrieved for this request\n\nMay be incomplete.\n\n' +
          spec.knowledge.map((k) => `- ${k.content}`).join('\n') +
          '\n',
      );
    }
  }

  /**
   * Projects an in-process sub-agent's OWN pinned skills, under its own prefix.
   *
   * A registered sub-agent bound `inline` (§13.3) brings its own skills, and DeepAgents
   * sub-agents deliberately do not inherit the parent's. Without this the child would run
   * without the procedures its author pinned to it -- silently, and producing plausible
   * answers, which is the worst way to lose a skill.
   *
   * The prefix keeps them out of the parent's `/skills/` scan, so the caller's model is
   * not offered procedures belonging to an agent it merely delegates to.
   *
   * Only JSON-authored (`instructions`-carrying) skills. An UPLOADED skill pinned to a
   * sub-agent is a known, documented gap rather than a silent one: this path still
   * projects synchronously into an in-memory map, and streaming an uploaded body in here
   * would need the same MinIO routing `/skills/` and `/workspace` already get, which this
   * class deliberately does not do for the sub-agent tree yet. Failing loudly here is
   * better than a sub-agent quietly reasoning without the procedure its author pinned to
   * it -- the exact failure mode this method exists to prevent for the JSON-authored case.
   */
  seedSubAgentSkills(alias: string, skills: SkillHandle[]): string[] {
    if (skills.length === 0) return [];
    const uploaded = skills.filter((s) => s.contentUri !== null);
    if (uploaded.length > 0) {
      throw new PlatformError(
        'internal',
        `Sub-agent "${alias}" is pinned an uploaded skill (${uploaded.map((s) => s.name).join(', ')}), ` +
          'which is not yet supported for in-process sub-agents -- only for the main agent.',
      );
    }
    const root = `/agents/${slug(alias)}/skills/`;
    for (const skill of skills) {
      this.seed(`${root}${slug(skill.name)}/SKILL.md`, skillDocument(skill));
    }
    return [root];
  }

  /**
   * The directory holding one named skill, for a helper that should see only some.
   *
   * Returns undefined when the skill was not pinned to this version, so a helper cannot
   * name a skill into existence -- the projection contains only what admission resolved.
   */
  skillPath(name: string): string | undefined {
    return this.skillNames.has(slug(name)) ? `/skills/${slug(name)}/` : undefined;
  }

  /** Paths the skills middleware should scan; empty when the version pinned none. */
  skillSources(): string[] {
    return this.skillNames.size > 0 ? ['/skills/'] : [];
  }

  /** Paths the memory middleware should load, in a stable order. */
  memorySources(): string[] {
    return [...this.files.keys()]
      .filter((p) => p.startsWith('/memory/') || p === '/knowledge/retrieved.md')
      .sort();
  }

  private seed(path: string, content: string): void {
    this.files.set(path, content);
    this.readOnly.add(path);
  }

  ls(path: string): LsResult {
    const dir = withSlash(path);
    const seen = new Map<string, FileInfo>();

    for (const p of this.files.keys()) {
      if (!p.startsWith(dir)) continue;
      const rest = p.slice(dir.length);
      const slash = rest.indexOf('/');
      // Non-recursive: anything deeper is reported as the directory that contains it,
      // once, which is what a caller listing a directory expects to see.
      if (slash === -1) {
        seen.set(p, { path: p, is_dir: false, size: this.files.get(p)!.length });
      } else {
        const child = `${dir}${rest.slice(0, slash)}/`;
        seen.set(child, { path: child, is_dir: true });
      }
    }
    return { files: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }

  read(filePath: string, offset = 0, limit = 500): ReadResult {
    const content = this.files.get(filePath);
    if (content === undefined) return { error: `File not found: ${filePath}` };
    const lines = content.split('\n');
    return { content: lines.slice(offset, offset + limit).join('\n'), mimeType: 'text/markdown' };
  }

  readRaw(filePath: string): ReadRawResult {
    const content = this.files.get(filePath);
    if (content === undefined) return { error: `File not found: ${filePath}` };
    return { data: { content, created_at: EPOCH, modified_at: EPOCH } as unknown as FileData };
  }

  grep(pattern: string, path?: string | null, glob?: string | null): GrepResult {
    const matches: GrepMatch[] = [];
    const base = path ? withSlash(path) : '/';
    for (const [p, content] of this.files) {
      if (!p.startsWith(base)) continue;
      if (glob && !matchesGlob(p, glob)) continue;
      content.split('\n').forEach((text, i) => {
        // Literal, not a regex: the protocol says "literal text pattern", and compiling
        // model-supplied text as a pattern is how a search becomes a hang.
        if (text.includes(pattern)) matches.push({ path: p, line: i + 1, text });
      });
    }
    return { matches };
  }

  glob(pattern: string, path = '/'): GlobResult {
    const base = withSlash(path);
    const files = [...this.files.keys()]
      .filter((p) => p.startsWith(base) && matchesGlob(p, pattern))
      .sort()
      .map((p) => ({ path: p, is_dir: false, size: this.files.get(p)!.length }));
    return { files };
  }

  write(filePath: string, content: string): WriteResult {
    if (this.readOnly.has(filePath)) {
      // A skill is a governed, versioned artifact (§17.2). Letting a run edit one would
      // make the next run's behaviour depend on the last run's improvisation, and no
      // eval could attribute a regression to anything.
      return { error: `${filePath} is provided by the platform and cannot be written` };
    }
    this.files.set(filePath, content);
    return { path: filePath, filesUpdate: null };
  }

  edit(filePath: string, oldString: string, newString: string, replaceAll = false): EditResult {
    if (this.readOnly.has(filePath)) {
      return { error: `${filePath} is provided by the platform and cannot be edited` };
    }
    const content = this.files.get(filePath);
    if (content === undefined) return { error: `File not found: ${filePath}` };
    if (!content.includes(oldString)) return { error: `String not found in ${filePath}` };

    const occurrences = replaceAll ? content.split(oldString).length - 1 : 1;
    this.files.set(
      filePath,
      replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString),
    );
    return { path: filePath, occurrences, filesUpdate: null };
  }

  delete(filePath: string): DeleteResult {
    if (this.readOnly.has(filePath)) {
      return { error: `${filePath} is provided by the platform and cannot be deleted` };
    }
    if (!this.files.delete(filePath)) return { error: `File not found: ${filePath}` };
    return { path: filePath };
  }

  /**
   * Not something a run of this class ever calls directly -- the gap that mattered was
   * `CompositeBackend`'s OWN `downloadFiles`/`uploadFiles`, which exist unconditionally on
   * that class regardless of what its routes support (see `deep-agents.adapter.ts`'s note
   * on why `/workspace` is routed there). Once this class sits behind a `CompositeBackend`,
   * any framework code that duck-types `if (backend.downloadFiles)` sees one on the
   * composite and calls it, which throws for a path that resolves to a route lacking the
   * method -- silently, in `listSkillsFromBackend`'s case, which swallows the error into a
   * `console.debug` and returns no skills. Implementing both here, even though nothing in
   * this class's own flow needs them, is what keeps every skill/memory/knowledge read
   * working once `/workspace` exists as a sibling route.
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return paths.map((path) => {
      const content = this.files.get(path);
      return content === undefined
        ? { path, content: null, error: 'file_not_found' as const }
        : { path, content: new TextEncoder().encode(content), error: null };
    });
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return files.map(([path, bytes]) => {
      if (this.readOnly.has(path)) return { path, error: 'permission_denied' as const };
      this.files.set(path, new TextDecoder().decode(bytes));
      return { path, error: null };
    });
  }
}

/** Fixed, because a projection has no meaningful mtime and a moving one breaks caching. */
const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * A SKILL.md the skills middleware can parse, for a JSON-authored skill.
 *
 * `description` carries `whenToUse`, because that is the field the middleware shows in the
 * prompt and therefore the only thing the model has to decide on before reading the body.
 * A skill whose author wrote no `whenToUse` gets a generic line -- worse, but not silent.
 *
 * Only for `instructions`-carrying skills -- an uploaded one (`contentUri` set) is already
 * a complete file and is streamed as-is (see `deep-agents.adapter.ts`'s skill seeding),
 * never rendered through this. Called with one anyway is a caller bug, not a data case to
 * degrade gracefully for -- silently rendering "null" into a skill body is worse than
 * throwing where the mistake was made.
 */
export function skillDocument(skill: SkillHandle): string {
  if (skill.instructions === null) {
    throw new PlatformError(
      'internal',
      `skillDocument called for "${skill.name}", which has no instructions (it is an uploaded skill)`,
    );
  }
  const description = skill.whenToUse ?? `The ${skill.name} procedure.`;
  return (
    `---\nname: ${slug(skill.name)}\ndescription: ${oneLine(description)}\n---\n\n` +
    `# ${skill.name} (v${skill.version})\n\n${skill.instructions}\n`
  );
}

/**
 * One tier per file, with provenance kept per record.
 *
 * §6.4 requires hearsay to stay distinguishable from first-party knowledge at the point of
 * use, so `unverified` is marked on the line rather than in a header the model may not
 * carry down to the fact it acts on.
 */
function memoryDocument(tier: string, records: RecalledMemory[]): string {
  return (
    `# Recalled ${tier} memory\n\n` +
    records
      .map((r) => `- (${r.provenance}${r.trusted ? '' : ', unverified'}) ${r.content ?? ''}`)
      .join('\n') +
    '\n'
  );
}

function groupByTier(recalled: RecalledMemory[]): Map<string, RecalledMemory[]> {
  const byTier = new Map<string, RecalledMemory[]>();
  for (const r of recalled) {
    const list = byTier.get(r.tier);
    if (list) list.push(r);
    else byTier.set(r.tier, [r]);
  }
  return byTier;
}

/**
 * POSIX path segment from author-chosen text, with no way to escape the directory.
 *
 * Exported: `deep-agents.adapter.ts`'s skill seeding computes the SAME path
 * (`/skills/${slug(name)}/SKILL.md`) that `skillPath`/`skillSources` above hand to the
 * model, and the two must agree exactly -- a second, slightly different slugifier here
 * would seed one path and advertise another.
 */
export const slug = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'unnamed';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const withSlash = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

/**
 * `*` within a segment, `**` across segments.
 *
 * Enough for the middleware's own patterns and for `*.md`, and deliberately not a full
 * glob engine: inventing one here would be a second thing to get wrong, in a projection
 * whose entire content the platform already chose.
 */
function matchesGlob(path: string, pattern: string): boolean {
  const CROSS = ' ';
  const body = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('**/', CROSS)
    .replaceAll('**', '.*')
    .replaceAll('*', '[^/]*')
    .replaceAll(CROSS, '(?:.*/)?');
  return new RegExp(pattern.startsWith('/') ? `^${body}$` : `(?:^|/)${body}$`).test(path);
}
