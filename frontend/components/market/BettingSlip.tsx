import { useState } from 'react';
import type { Market } from '../../types/market';

interface BettingSlipProps {
  market: Market;
  onPlaceBet?: (outcomeId: string, amount: number) => void;
}

const MIN_TOUCH_TARGET = 'min-h-[48px]';

export default function BettingSlip({ market, onPlaceBet }: BettingSlipProps) {
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>('');
  const [isOpen, setIsOpen] = useState(false);

  const handlePlaceBet = () => {
    if (!selectedOutcome || !amount) return;
    onPlaceBet?.(selectedOutcome, Number(amount));
  };

  return (
    <>
      {/* Mobile: persistent bottom drawer */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white shadow-lg sm:hidden"
        role="region"
        aria-label="Betting slip"
      >
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
          className={`flex w-full items-center justify-between px-4 ${MIN_TOUCH_TARGET} text-left font-medium text-gray-900`}
        >
          <span>Betting Slip</span>
          <span aria-hidden="true">{isOpen ? '\u25be' : '\u25b4'}</span>
        </button>

        {isOpen && (
          <div className="max-h-[70vh] overflow-y-auto px-4 pb-4">
            <div className="flex flex-col gap-3">
              {market.outcomes.map((outcome) => (
                <button
                  key={outcome.id}
                  type="button"
                  onClick={() => setSelectedOutcome(outcome.id)}
                  aria-pressed={selectedOutcome === outcome.id}
                  className={`flex w-full items-center justify-between rounded-md border px-4 ${MIN_TOUCH_TARGET} ${
                    selectedOutcome === outcome.id
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-gray-300 text-gray-800'
                  }`}
                >
                  <span className="truncate">{outcome.label}</span>
                  <span className="ml-2 shrink-0 font-semibold">{outcome.price}</span>
                </button>
              ))}

              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount"
                aria-label="Bet amount"
                className={`w-full rounded-md border border-gray-300 px-4 ${MIN_TOUCH_TARGET} text-base`}
              />

              <button
                type="button"
                onClick={handlePlaceBet}
                disabled={!selectedOutcome || !amount}
                className={`w-full rounded-md bg-blue-600 px-4 ${MIN_TOUCH_TARGET} font-semibold text-white disabled:opacity-50`}
              >
                Place Bet
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Desktop: inline slip */}
      <aside className="hidden w-full flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex">
        <h2 className="text-lg font-semibold text-gray-900">Betting Slip</h2>
        {market.outcomes.map((outcome) => (
          <button
            key={outcome.id}
            type="button"
            onClick={() => setSelectedOutcome(outcome.id)}
            aria-pressed={selectedOutcome === outcome.id}
            className={`flex w-full items-center justify-between rounded-md border px-4 ${MIN_TOUCH_TARGET} ${
              selectedOutcome === outcome.id
                ? 'border-blue-600 bg-blue-50 text-blue-700'
                : 'border-gray-300 text-gray-800'
            }`}
          >
            <span className="truncate">{outcome.label}</span>
            <span className="ml-2 shrink-0 font-semibold">{outcome.price}</span>
          </button>
        ))}
        <input
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount"
          aria-label="Bet amount"
          className={`w-full rounded-md border border-gray-300 px-4 ${MIN_TOUCH_TARGET} text-base`}
        />
        <button
          type="button"
          onClick={handlePlaceBet}
          disabled={!selectedOutcome || !amount}
          className={`w-full rounded-md bg-blue-600 px-4 ${MIN_TOUCH_TARGET} font-semibold text-white disabled:opacity-50`}
        >
          Place Bet
        </button>
      </aside>
    </>
  );
}
