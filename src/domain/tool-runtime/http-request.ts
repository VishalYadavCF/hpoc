/**
 * Builds a concrete HTTP request from a registered tool row plus call arguments.
 *
 * Pure and dependency-free so the URL-construction rules -- which are the security
 * boundary -- are testable without a network, a database or a sandbox.
 *
 * The threat this exists to contain: once a caller's arguments reach a URL, a tool row is
 * one bad interpolation away from being a server-side request forgery primitive with a
 * registry table in front of it. Every rule below is there for that reason.
 */

export interface HttpToolShape {
  /** Origin plus any fixed prefix. The resolved URL is checked back against its origin. */
  endpointUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** RFC 6570-style: `{name}` is one encoded segment, `{+name}` allows slashes. */
  pathTemplate: string | null;
  argPlacement: 'query' | 'body' | 'none' | null;
  staticHeaders: Record<string, string>;
}

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** Which arguments the path consumed, so the caller can see what went where. */
  consumedByPath: string[];
}

export class HttpToolShapeError extends Error {}

const PLACEHOLDER = /\{(\+?)([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function buildHttpRequest(
  shape: HttpToolShape,
  args: Record<string, unknown>,
): BuiltRequest {
  let base: URL;
  try {
    base = new URL(shape.endpointUrl);
  } catch {
    throw new HttpToolShapeError(`endpoint_url is not a valid URL: ${shape.endpointUrl}`);
  }
  // http and https only. A tool row naming file:, gopher: or data: is either a mistake or
  // an attempt to read the worker's own filesystem.
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new HttpToolShapeError(`endpoint_url must be http or https, got ${base.protocol}`);
  }

  const consumedByPath: string[] = [];
  let url: URL;

  if (shape.pathTemplate) {
    const path = shape.pathTemplate.replace(PLACEHOLDER, (_match, reserved: string, name: string) => {
      if (!(name in args)) {
        throw new HttpToolShapeError(`path_template needs argument "${name}", which was not supplied`);
      }
      const raw = args[name];
      if (raw === null || raw === undefined || typeof raw === 'object') {
        throw new HttpToolShapeError(`path argument "${name}" must be a scalar`);
      }
      consumedByPath.push(name);
      const value = String(raw);

      if (reserved === '+') {
        // Reserved expansion keeps `/` so an API can take a file path in one position.
        // `..` is still refused: a traversal is never a legitimate path argument, and
        // normalisation below would otherwise let it climb out of the template's prefix.
        if (value.split('/').some((segment) => segment === '..' || segment === '.')) {
          throw new HttpToolShapeError(`path argument "${name}" may not contain . or .. segments`);
        }
        return value.split('/').map(encodeURIComponent).join('/');
      }
      // Plain expansion: ONE segment. encodeURIComponent turns `/` into %2F, so a value
      // cannot invent a path segment the template did not declare.
      return encodeURIComponent(value);
    });

    // Joined so the template cannot escape the endpoint's own prefix: a leading `/` on the
    // template would otherwise reset the path to the host root.
    const prefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
    const suffix = path.startsWith('/') ? path : `/${path}`;
    url = new URL(base.origin + prefix + suffix);
  } else {
    url = new URL(base.toString());
  }

  // The guard that makes the rest safe. Even with encoding, an argument that reached the
  // authority component would change where this request goes; comparing origins after
  // construction catches that whatever the mechanism.
  if (url.origin !== base.origin) {
    throw new HttpToolShapeError(
      `resolved URL origin ${url.origin} does not match the registered ${base.origin}`,
    );
  }

  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!consumedByPath.includes(key)) remaining[key] = value;
  }

  const placement =
    shape.argPlacement ??
    (shape.method === 'GET' || shape.method === 'DELETE' ? 'query' : 'body');

  let body: string | null = null;
  if (placement === 'query') {
    for (const [key, value] of Object.entries(remaining)) {
      if (value === null || value === undefined) continue;
      // Objects and arrays have no one obvious query encoding, and picking one silently
      // would make a tool behave differently from its own input schema.
      if (typeof value === 'object') {
        throw new HttpToolShapeError(`query argument "${key}" must be a scalar`);
      }
      url.searchParams.set(key, String(value));
    }
  } else if (placement === 'body') {
    body = JSON.stringify(remaining);
  }

  const headers: Record<string, string> = { ...shape.staticHeaders };
  if (body !== null) headers['content-type'] = 'application/json';

  return { url: url.toString(), method: shape.method, headers, body, consumedByPath };
}
