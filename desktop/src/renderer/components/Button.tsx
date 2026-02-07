type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-green-primary hover:bg-green-dim text-bg-page font-medium',
  secondary: 'bg-bg-surface hover:bg-bg-hover border border-border-secondary text-text-primary',
  ghost: 'hover:bg-bg-hover text-text-secondary',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export default function Button({ variant = 'secondary', size = 'md', className = '', children, ...props }: ButtonProps) {
  const sizeClass = size === 'sm' ? 'px-3 py-1 text-[10px]' : 'px-4 py-2 text-xs';
  return (
    <button
      className={`rounded-md transition-colors ${variants[variant]} ${sizeClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
