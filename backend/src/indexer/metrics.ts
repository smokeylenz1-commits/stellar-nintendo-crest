import { Router, Request, Response } from 'express';
import { Pool } from 'pg';

/**
 * Prometheus-style metrics endpoint for the indexer.
 *
 * Exposes indexer progress plus oracle treasury / bond health gauges so that
 * alerting rules can fire when the relayer wallet runs low on XLM or the
 * escrowed challenge bond capacity is depleted.
 */

export interface OracleTreasurySnapshot {
  /** Relayer wallet XLM balance (in XLM, not stroops). */
  walletXlm: number;
  /** Total XLM currently escrowed for challenge bonds. */
  escrowedBondXlm: number;
  /** Minimum XLM required to keep the relayer operational. */
  minWalletXlm: number;
  /** Minimum escrowed bond capacity required to accept challenges. */
  minBondXlm: number;
  /** Unix ms timestamp of the last successful balance check. */
  checkedAt: number;
}

const DEFAULT_MIN_WALLET_XLM = 100;
const DEFAULT_MIN_BOND_XLM = 100;

let latestTreasury: OracleTreasurySnapshot | null = null;

export function setOracleTreasurySnapshot(snapshot: OracleTreasurySnapshot): void {
  latestTreasury = snapshot;
}

export function getOracleTreasurySnapshot(): OracleTreasurySnapshot | null {
  return latestTreasury;
}

function formatGauge(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

function renderTreasuryMetrics(): string {
  const snapshot = latestTreasury;
  if (!snapshot) {
    return (
      '# HELP oracle_treasury_snapshot_available Whether a treasury balance snapshot has been recorded\n' +
      '# TYPE oracle_treasury_snapshot_available gauge\n' +
      'oracle_treasury_snapshot_available 0\n'
    );
  }

  const walletLow = snapshot.walletXlm < snapshot.minWalletXlm ? 1 : 0;
  const bondDepleted = snapshot.escrowedBondXlm < snapshot.minBondXlm ? 1 : 0;

  return (
    '# HELP oracle_treasury_snapshot_available Whether a treasury balance snapshot has been recorded\n' +
    '# TYPE oracle_treasury_snapshot_available gauge\n' +
    'oracle_treasury_snapshot_available 1\n' +
    formatGauge(
      'oracle_relayer_wallet_xlm',
      'Current relayer wallet XLM balance',
      snapshot.walletXlm,
    ) +
    formatGauge(
      'oracle_relayer_wallet_min_xlm',
      'Minimum relayer wallet XLM balance threshold',
      snapshot.minWalletXlm,
    ) +
    formatGauge(
      'oracle_relayer_wallet_low',
      '1 when the relayer wallet XLM balance is below the threshold',
      walletLow,
    ) +
    formatGauge(
      'oracle_escrowed_bond_xlm',
      'Current escrowed challenge bond capacity in XLM',
      snapshot.escrowedBondXlm,
    ) +
    formatGauge(
      'oracle_escrowed_bond_min_xlm',
      'Minimum escrowed challenge bond capacity threshold',
      snapshot.minBondXlm,
    ) +
    formatGauge(
      'oracle_escrowed_bond_depleted',
      '1 when escrowed challenge bond capacity is below the threshold',
      bondDepleted,
    ) +
    formatGauge(
      'oracle_treasury_last_check_timestamp_seconds',
      'Unix timestamp (seconds) of the last treasury balance check',
      Math.floor(snapshot.checkedAt / 1000),
    )
  );
}

export function createMetricsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { rows } = await pool.query<{ last_ledger: string | null }>(
        'SELECT MAX(ledger) AS last_ledger FROM events',
      );
      const lastLedger = rows[0]?.last_ledger ?? '0';

      const body =
        '# HELP indexer_last_ledger Last indexed ledger sequence\n' +
        '# TYPE indexer_last_ledger gauge\n' +
        `indexer_last_ledger ${lastLedger}\n` +
        renderTreasuryMetrics();

      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(200).send(body);
    } catch (err) {
      res.status(500).send(`# indexer metrics error: ${(err as Error).message}\n`);
    }
  });

  return router;
}

export const ORACLE_TREASURY_DEFAULTS = {
  minWalletXlm: DEFAULT_MIN_WALLET_XLM,
  minBondXlm: DEFAULT_MIN_BOND_XLM,
};
