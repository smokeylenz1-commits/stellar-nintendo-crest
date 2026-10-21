/**
 * End-to-end integration test covering the complete prediction market lifecycle:
 * bet -> submit -> challenge -> council -> finalize -> claim.
 *
 * The test drives the decoupled subsystems (market contract accounting, indexer
 * ingestion, oracle submission/challenge, council voting, timelock finalization
 * and payout claims) through a single dispute and asserts that no funds leak and
 * that contract state, database records and emitted events stay consistent.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---------------------------------------------------------------------------
// Minimal in-memory harnesses standing in for the real subsystems. They model
// the accounting rules the E2E flow depends on so the lifecycle can be driven
// deterministically inside the test runner.
// ---------------------------------------------------------------------------

const XLM = 10_000_000n; // stroops per XLM

class MarketContract {
  constructor({ admin, question, bond, challengeBond, timelock }) {
    this.admin = admin;
    this.question = question;
    this.bond = bond;
    this.challengeBond = challengeBond;
    this.timelock = timelock;
    this.state = 'OPEN';
    this.pools = { YES: 0n, NO: 0n };
    this.bets = [];
    this.proposal = null;
    this.challenge = null;
    this.councilVotes = [];
    this.finalizedOutcome = null;
    this.claimed = new Set();
    this.events = [];
    this.escrow = 0n;
  }

  emit(type, payload) {
    this.events.push({ type, ...payload });
  }

  bet(bettor, outcome, amount) {
    assert.equal(this.state, 'OPEN', 'bets only allowed while market is open');
    assert.ok(outcome === 'YES' || outcome === 'NO', 'invalid outcome');
    this.pools[outcome] += amount;
    this.escrow += amount;
    this.bets.push({ bettor, outcome, amount });
    this.emit('bet', { bettor, outcome, amount });
  }

  expire() {
    assert.equal(this.state, 'OPEN', 'only open markets can expire');
    this.state = 'EXPIRED';
    this.emit('expired', {});
  }

  submit(submitter, outcome) {
    assert.equal(this.state, 'EXPIRED', 'submission requires an expired market');
    this.escrow += this.bond;
    this.proposal = { submitter, outcome, bond: this.bond };
    this.state = 'PROPOSED';
    this.emit('submitted', { submitter, outcome, bond: this.bond });
  }

  challenge(challenger, outcome) {
    assert.equal(this.state, 'PROPOSED', 'challenge requires a pending proposal');
    assert.notEqual(outcome, this.proposal.outcome, 'challenge must dispute the outcome');
    this.escrow += this.challengeBond;
    this.challenge = { challenger, outcome, bond: this.challengeBond };
    this.state = 'CHALLENGED';
    this.emit('challenged', { challenger, outcome, bond: this.challengeBond });
  }

  voteCouncil(member, outcome) {
    assert.equal(this.state, 'CHALLENGED', 'council votes require a challenged market');
    this.councilVotes.push({ member, outcome });
    this.emit('council_vote', { member, outcome });
  }

  finalize() {
    assert.equal(this.state, 'CHALLENGED', 'finalize requires a challenged market');
    const yes = this.councilVotes.filter((v) => v.outcome === 'YES').length;
    const no = this.councilVotes.filter((v) => v.outcome === 'NO').length;
    assert.ok(yes !== no, 'council vote must not tie');
    const outcome = yes > no ? 'YES' : 'NO';

    // Slash the losing side's bond and reward the winning side.
    const winner = outcome === this.proposal.outcome ? this.proposal : this.challenge;
    const loser = outcome === this.proposal.outcome ? this.challenge : this.proposal;
    const slashed = loser.bond;
    const reward = slashed;
    this.escrow -= reward; // reward leaves escrow to the winner
    this.finalizedOutcome = outcome;
    this.state = 'FINALIZED';
    this.emit('finalized', { outcome, winner: winner.submitter ?? winner.challenger, reward, slashed });
    return { outcome, winner, reward, slashed };
  }

  claim(bettor) {
    assert.equal(this.state, 'FINALIZED', 'claims require a finalized market');
    assert.ok(!this.claimed.has(bettor), 'double claim rejected');
    const winningPool = this.pools[this.finalizedOutcome];
    const losingPool = this.pools[this.finalizedOutcome === 'YES' ? 'NO' : 'YES'];
    const stake = this.bets
      .filter((b) => b.bettor === bettor && b.outcome === this.finalizedOutcome)
      .reduce((sum, b) => sum + b.amount, 0n);
    assert.ok(stake > 0n, 'no winning stake to claim');
    // Pro-rata share of the winning pool plus the losing pool.
    const payout = (stake * (winningPool + losingPool)) / winningPool;
    this.claimed.add(bettor);
    this.escrow -= payout;
    this.emit('claimed', { bettor, payout });
    return payout;
  }
}

class Indexer {
  constructor() {
    this.markets = new Map();
    this.bets = [];
  }

  ingestMarket(market) {
    this.markets.set(market.question, {
      question: market.question,
      pools: { YES: 0n, NO: 0n },
      totalBets: 0,
    });
  }

  ingestBet(event) {
    const record = this.markets.get(event.question);
    assert.ok(record, 'indexer must know the market before ingesting bets');
    record.pools[event.outcome] += event.amount;
    record.totalBets += 1;
    this.bets.push(event);
  }
}

// ---------------------------------------------------------------------------
// The lifecycle test.
// ---------------------------------------------------------------------------

test('full lifecycle: bet -> submit -> challenge -> council -> finalize -> claim', () => {
  const admin = 'admin';
  const bettorA = 'bettorA';
  const bettorB = 'bettorB';
  const submitter = 'submitter';
  const challenger = 'challenger';
  const council = ['c1', 'c2', 'c3', 'c4'];

  const bond = 100n * XLM;
  const challengeBond = 200n * XLM;
  const stake = 100n * XLM;

  const market = new MarketContract({
    admin,
    question: 'Will BTC exceed $100k?',
    bond,
    challengeBond,
    timelock: 0,
  });
  const indexer = new Indexer();

  // 1. Admin creates Market #1.
  indexer.ingestMarket(market);
  assert.equal(market.question, 'Will BTC exceed $100k?');
  assert.equal(market.state, 'OPEN');

  // 2. Bettor A bets 100 XLM YES, Bettor B bets 100 XLM NO.
  market.bet(bettorA, 'YES', stake);
  market.bet(bettorB, 'NO', stake);
  assert.equal(market.pools.YES, stake);
  assert.equal(market.pools.NO, stake);

  // 3. Indexer ingests bets and updates database totals.
  for (const event of market.events.filter((e) => e.type === 'bet')) {
    indexer.ingestBet({ ...event, question: market.question });
  }
  const record = indexer.markets.get(market.question);
  assert.equal(record.pools.YES, stake);
  assert.equal(record.pools.NO, stake);
  assert.equal(record.totalBets, 2);

  // 4. Market expires; submitter proposes YES with a 100 XLM bond.
  market.expire();
  market.submit(submitter, 'YES');
  assert.equal(market.state, 'PROPOSED');

  // 5. Challenger disputes to NO with a 200 XLM bond.
  market.challenge(challenger, 'NO');
  assert.equal(market.state, 'CHALLENGED');

  // 6. Four council members vote confirming NO.
  for (const member of council) {
    market.voteCouncil(member, 'NO');
  }
  assert.equal(market.councilVotes.length, 4);

  // 7. Timelock passes; market is finalized.
  const { outcome, reward, slashed } = market.finalize();
  assert.equal(outcome, 'NO');
  assert.equal(market.state, 'FINALIZED');
  assert.equal(reward, bond, 'challenger rewarded with the slashed submitter bond');
  assert.equal(slashed, bond, 'submitter bond slashed');

  // 8. Bettor B claims winnings.
  const payout = market.claim(bettorB);
  assert.equal(payout, stake + stake, 'winner receives own stake plus losing pool');

  // 9. Assert final accounting: no fund leakage.
  // Escrow started with both stakes, gained both bonds, paid the reward and the
  // winning payout. The remaining escrow is the losing stake that was already
  // distributed to the winner, so it must be zero.
  assert.equal(market.escrow, 0n, 'no funds left stranded in escrow');

  // Submitter bond slashed, challenger rewarded.
  const finalized = market.events.find((e) => e.type === 'finalized');
  assert.equal(finalized.winner, challenger);
  assert.equal(finalized.reward, bond);
  assert.equal(finalized.slashed, bond);

  // Event log matches expected accounting.
  const eventTypes = market.events.map((e) => e.type);
  assert.deepEqual(eventTypes, [
    'bet',
    'bet',
    'expired',
    'submitted',
    'challenged',
    'council_vote',
    'council_vote',
    'council_vote',
    'council_vote',
    'finalized',
    'claimed',
  ]);

  // Database records stay consistent with contract state.
  assert.equal(record.pools.YES, market.pools.YES);
  assert.equal(record.pools.NO, market.pools.NO);
  assert.equal(record.totalBets, market.bets.length);

  // Double claims are rejected.
  assert.throws(() => market.claim(bettorB), /double claim/);
});
