export function readCodexUsage(options?: {
  open?: (...args: any[]) => any;
  codexPath?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{
  buckets: {
    bucketKey: string | null;
    primary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
    secondary: { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null } | null;
  }[];
}>;
