import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  options: DropdownOption[];
  value?: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  label,
  placeholder = 'Select an option',
  disabled = false,
  className = '',
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const labelId = `${baseId}-label`;

  const selected = options.find((o) => o.value === value);

  const enabledIndexes = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const focusOption = useCallback((index: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${index}"]`
    );
    el?.focus();
  }, []);

  const openList = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    const selectedIndex = options.findIndex((o) => o.value === value);
    const initial =
      selectedIndex >= 0 && !options[selectedIndex].disabled
        ? selectedIndex
        : enabledIndexes[0] ?? -1;
    setActiveIndex(initial);
  }, [disabled, options, value, enabledIndexes]);

  const closeList = useCallback((returnFocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const selectOption = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      closeList();
    },
    [options, onChange, closeList]
  );

  useEffect(() => {
    if (open && activeIndex >= 0) {
      focusOption(activeIndex);
    }
  }, [open, activeIndex, focusOption]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeList(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, closeList]);

  const moveActive = (direction: 1 | -1) => {
    if (enabledIndexes.length === 0) return;
    const currentPos = enabledIndexes.indexOf(activeIndex);
    let nextPos: number;
    if (currentPos === -1) {
      nextPos = direction === 1 ? 0 : enabledIndexes.length - 1;
    } else {
      nextPos =
        (currentPos + direction + enabledIndexes.length) % enabledIndexes.length;
    }
    setActiveIndex(enabledIndexes[nextPos]);
  };

  const handleButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!open) openList();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeList();
        }
        break;
      case 'Tab':
        if (open) closeList(false);
        break;
      default:
        break;
    }
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (enabledIndexes.length) setActiveIndex(enabledIndexes[0]);
        break;
      case 'End':
        event.preventDefault();
        if (enabledIndexes.length)
          setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (activeIndex >= 0) selectOption(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        closeList();
        break;
      case 'Tab':
        closeList(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {label && (
        <span id={labelId} className="mb-1 block text-sm font-medium text-gray-700">
          {label}
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-label={!label ? placeholder : undefined}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={handleButtonKeyDown}
        className="flex w-full items-center justify-between rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-sm text-gray-900 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={selected ? 'text-gray-900' : 'text-gray-500'}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          aria-hidden="true"
          className={`ml-2 h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={label ? labelId : undefined}
          aria-activedescendant={
            activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined
          }
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg focus:outline-none"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <li
                key={option.value}
                id={`${baseId}-option-${index}`}
                data-option-index={index}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                tabIndex={-1}
                onClick={() => selectOption(index)}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                className={[
                  'flex cursor-pointer items-center justify-between px-3 py-2',
                  option.disabled
                    ? 'cursor-not-allowed text-gray-400'
                    : 'text-gray-900',
                  isActive && !option.disabled ? 'bg-indigo-50' : '',
                  isSelected ? 'font-medium' : '',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500',
                ].join(' ')}
              >
                <span>{option.label}</span>
                {isSelected && (
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4 text-indigo-600"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 111.42-1.42l2.79 2.79 6.79-6.79a1 1 0 011.42 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default Dropdown;
