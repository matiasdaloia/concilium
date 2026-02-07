type BadgeVariant = 'green' | 'blue' | 'amber' | 'red' | 'muted';

const variants: Record<BadgeVariant, string> = {
  green: 'bg-green-primary/20 text-green-primary',
  blue: 'bg-blue-info/20 text-blue-info',
  amber: 'bg-amber-warning/20 text-amber-warning',
  red: 'bg-red-error/20 text-red-error',
  muted: 'bg-bg-hover text-text-muted',
};

export default function Badge({ children, variant = 'muted' }: { children: React.ReactNode; variant?: BadgeVariant }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${variants[variant]}`}>
      {children}
    </span>
  );
}
