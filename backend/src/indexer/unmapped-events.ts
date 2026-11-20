import { xdr, Address, scValToNative } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

export type ScValTopic =
  | { type: 'symbol'; value: string }
  | { type: 'address'; value: string }
  | { type: 'i128'; value: bigint }
  | { type: 'u64'; value: bigint }
  | { type: 'vec'; value: ScValTopic[] }
  | { type: 'unknown'; raw: string };

function toHex(raw: unknown): string {
  try {
    if (raw instanceof xdr.ScVal) {
      return raw.toXDR().toString('hex');
    }
    if (Buffer.isBuffer(raw)) {
      return raw.toString('hex');
    }
    if (typeof raw === 'string') {
      return Buffer.from(raw, 'utf8').toString('hex');
    }
    return Buffer.from(JSON.stringify(raw) ?? '').toString('hex');
  } catch {
    return '';
  }
}

function parseAddress(scVal: xdr.ScVal): string {
  const address = Address.fromScVal(scVal);
  // toString() handles account (G...), muxed (M...) and contract (C...) addresses.
  return address.toString();
}

/**
 * Parse a raw Soroban ScVal contract event topic into a typed model.
 * Uses strict type checking and exhaustive switch cases so unexpected
 * shapes are logged with their raw hex payload instead of throwing.
 */
export function parseScValTopic(scVal: xdr.ScVal): ScValTopic {
  try {
    switch (scVal.switch()) {
      case xdr.ScValType.scvSymbol():
        return { type: 'symbol', value: scVal.sym().toString() };
      case xdr.ScValType.scvAddress():
        return { type: 'address', value: parseAddress(scVal) };
      case xdr.ScValType.scvI128(): {
        const native = scValToNative(scVal);
        return { type: 'i128', value: BigInt(native as bigint | string | number) };
      }
      case xdr.ScValType.scvU64(): {
        const native = scValToNative(scVal);
        return { type: 'u64', value: BigInt(native as bigint | string | number) };
      }
      case xdr.ScValType.scvVec(): {
        const items = scVal.vec() ?? [];
        return { type: 'vec', value: items.map((item) => parseScValTopic(item)) };
      }
      default: {
        const raw = toHex(scVal);
        logger.error(
          { scValType: scVal.switch().name, rawHex: raw },
          'Unexpected ScVal topic shape encountered while parsing contract event',
        );
        return { type: 'unknown', raw };
      }
    }
  } catch (err) {
    const raw = toHex(scVal);
    logger.error(
      { err, rawHex: raw },
      'Failed to parse ScVal topic; returning unknown variant',
    );
    return { type: 'unknown', raw };
  }
}

export function parseScValTopics(topics: xdr.ScVal[]): ScValTopic[] {
  return topics.map((topic) => parseScValTopic(topic));
}
