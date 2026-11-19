export type MarketCategory =
  | 'Crypto'
  | 'Politics'
  | 'Sports'
  | 'Science'
  | 'Entertainment'
  | 'Tech';

export interface Market {
  id: string;
  question: string;
  category?: MarketCategory;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  outcomes?: string[];
  imageUrl?: string;
  [key: string]: unknown;
}
