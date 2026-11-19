import React, { forwardRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, renders a spinner and disables interaction. */
  loading?: boolean;
  /** Optional accessible label when the button has no visible text. */
  ariaLabel?: string;
  fullWidth?: boolean;
}

const baseClasses =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-blue-500 focus-visible:ring-offset-slate-900 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-500',
  secondary: 'bg-slate-700 text-slate-100 hover:bg-slate-600',
  ghost: 'bg-transparent text-slate-200 hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-12 px-6 text-lg',
};

/**
 * Accessible button primitive.
 *
 * - Native <button> semantics so it is keyboard operable by default.
 * - Visible focus ring via `focus-visible:ring-2` for keyboard users.
 * - `aria-busy` while loading and `aria-label` fallback for icon-only buttons.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    ariaLabel,
    fullWidth = false,
    className = '',
    disabled,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = [
    baseClasses,
    variantClasses[variant],
    sizeClasses[size],
    fullWidth ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      {...rest}
    >
      {loading && (
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
});

export default Button;
