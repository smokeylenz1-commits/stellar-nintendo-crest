import React from 'react';

interface OddsButtonProps {
  odds: number;
  label?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

const OddsButton: React.FC<OddsButtonProps> = ({
  odds,
  label,
  selected = false,
  disabled = false,
  onClick,
}) => {
  const accessibleLabel = label
    ? `${label}, odds ${odds}`
    : `Odds ${odds}`;

  return (
    <button
      type="button"
      className={`odds-button${selected ? ' odds-button--selected' : ''}`}
      aria-label={accessibleLabel}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{odds}</span>
    </button>
  );
};

export default OddsButton;
