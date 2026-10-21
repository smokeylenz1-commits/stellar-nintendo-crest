// Shared frontend types

export type BondRole = 'submitter' | 'challenger';

export type BondStatus = 'escrowed' | 'returned' | 'slashed';

export interface OracleBond {
  id: string;
  marketId: string;
  marketTitle: string;
  role: BondRole;
  amount: string;
  status: BondStatus;
  reward?: string;
  txHash: string;
  createdAt: string;
  resolvedAt?: string;
}
