import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

/**
 * Minimal Prometheus registry.
 *
 * Deliberately not prom-client: the metrics that matter at 2am (§0.8) are a handful of
 * gauges and counters, and a text exposition format is thirty lines. Swap it for
 * prom-client the moment histograms are needed — the call sites do not change.
 */
@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>();
  private readonly help = new Map<string, string>();

  /**
   * Latency buckets in milliseconds.
   *
   * Chosen for what this system actually does rather than a default ladder: sub-100ms is
   * queue and platform overhead, 100ms-5s is a model call, and past 30s is a long tool or
   * a human. A ladder without resolution in those bands cannot answer "is the model slow
   * or is the queue deep", which is the question §15.4 exists for.
   */
  private static readonly LATENCY_BUCKETS = [
    5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
  ];

  private key(name: string, labels?: Labels): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const inner = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '')}"`)
      .join(',');
    return `${name}{${inner}}`;
  }

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  increment(name: string, labels?: Labels, by = 1): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Prometheus histogram: cumulative buckets plus _sum and _count. */
  observe(name: string, value: number, labels?: Labels, buckets = Metrics.LATENCY_BUCKETS): void {
    const key = this.key(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { buckets, counts: new Array<number>(buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, histogram);
    }
    // The final slot is +Inf, which is why counts is one longer than buckets.
    let index = histogram.buckets.findIndex((b) => value <= b);
    if (index === -1) index = histogram.buckets.length;
    histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
    histogram.sum += value;
    histogram.count += 1;
  }

  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();
    const emit = (map: Map<string, number>, type: string) => {
      for (const [key, value] of map) {
        const name = key.split('{')[0]!;
        if (!emitted.has(name)) {
          emitted.add(name);
          const help = this.help.get(name);
          if (help) lines.push(`# HELP ${name} ${help}`);
          lines.push(`# TYPE ${name} ${type}`);
        }
        lines.push(`${key} ${value}`);
      }
    };
    emit(this.counters, 'counter');
    emit(this.gauges, 'gauge');

    for (const [key, histogram] of this.histograms) {
      const [name, labelPart] = splitKey(key);
      if (!emitted.has(name)) {
        emitted.add(name);
        const help = this.help.get(name);
        if (help) lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} histogram`);
      }
      let cumulative = 0;
      histogram.buckets.forEach((bound, i) => {
        cumulative += histogram.counts[i] ?? 0;
        lines.push(`${name}_bucket${withLabel(labelPart, `le="${bound}"`)} ${cumulative}`);
      });
      cumulative += histogram.counts[histogram.buckets.length] ?? 0;
      lines.push(`${name}_bucket${withLabel(labelPart, 'le="+Inf"')} ${cumulative}`);
      lines.push(`${name}_sum${labelPart} ${histogram.sum}`);
      lines.push(`${name}_count${labelPart} ${histogram.count}`);
    }

    return lines.join('\n') + '\n';
  }
}

const splitKey = (key: string): [string, string] => {
  const brace = key.indexOf('{');
  return brace === -1 ? [key, ''] : [key.slice(0, brace), key.slice(brace)];
};

/** Merges `le` into an existing label set, since Prometheus needs it inside the braces. */
const withLabel = (labelPart: string, extra: string): string =>
  labelPart === '' ? `{${extra}}` : `${labelPart.slice(0, -1)},${extra}}`;
