import { cn } from "@/lib/utils/cn";

/** OpenSAM Studio mark: a frame with a traced subject silhouette. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden="true">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="#15181d" stroke="#2c3038" />
      <path d="M7 11V7h4M25 11V7h-4M7 21v4h4M25 21v4h-4" fill="none" stroke="#6b717c" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M16 8.6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-4.6 15.4 1-5.2c.3-1.5 1.7-2.6 3.3-2.6h.6c1.6 0 3 1.1 3.3 2.6l1 5.2"
        fill="none"
        stroke="#c6f432"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="2.4 1.6"
      />
    </svg>
  );
}
