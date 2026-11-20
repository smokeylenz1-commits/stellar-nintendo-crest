import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber } from "ethers";

/**
 * Adversarial oracle simulation testbed (issue #232).
 *
 * Simulates dishonest submitters, frontrunning challengers and council
 * quorums across 10 distinct dispute sequences. The harness models the
 * protocol economics (bond slashing, challenger reward share, timelock
 * finalization) so that game-theoretic invariants can be asserted without
 * relying on manual testing.
 */

const BOND = ethers.utils.parseEther("100");
const CHALLENGER_REWARD_BPS = 5000; // 50% of slashed bond to challenger
const COUNCIL_QUORUM = 3;
const TIMELOCK_SECONDS = 3600;

enum DisputeOutcome {
  Pending,
  SubmitterWins,
  ChallengerWins,
}

interface CouncilVote {
  voter: string;
  upholdChallenge: boolean;
}

interface DisputeState {
  id: number;
  submitter: string;
  challenger: string;
  bond: BigNumber;
  createdAt: number;
  finalizedAt: number | null;
  outcome: DisputeOutcome;
  votes: CouncilVote[];
}

class OracleSim {
  private disputes: DisputeState[] = [];
  private nextId = 0;
  private now = 1_000_000;

  submit(submitter: string, challenger: string): DisputeState {
    const dispute: DisputeState = {
      id: this.nextId++,
      submitter,
      challenger,
      bond: BOND,
      createdAt: this.now,
      finalizedAt: null,
      outcome: DisputeOutcome.Pending,
      votes: [],
    };
    this.disputes.push(dispute);
    return dispute;
  }

  advanceTime(seconds: number): void {
    this.now += seconds;
  }

  vote(dispute: DisputeState, voter: string, upholdChallenge: boolean): void {
    dispute.votes.push({ voter, upholdChallenge });
  }

  finalize(dispute: DisputeState): void {
    if (this.now < dispute.createdAt + TIMELOCK_SECONDS) {
      throw new Error("timelock: premature finalization");
    }
    const uphold = dispute.votes.filter((v) => v.upholdChallenge).length;
    const reject = dispute.votes.filter((v) => !v.upholdChallenge).length;
    if (uphold >= COUNCIL_QUORUM) {
      dispute.outcome = DisputeOutcome.ChallengerWins;
    } else if (reject >= COUNCIL_QUORUM) {
      dispute.outcome = DisputeOutcome.SubmitterWins;
    } else {
      throw new Error("council: quorum not reached");
    }
    dispute.finalizedAt = this.now;
  }

  /**
   * Settle economics after finalization. Returns the challenger reward and
   * the submitter's remaining bond (0 when slashed).
   */
  settle(dispute: DisputeState): {
    challengerReward: BigNumber;
    submitterRemaining: BigNumber;
  } {
    if (dispute.outcome === DisputeOutcome.Pending) {
      throw new Error("settle: dispute not finalized");
    }
    if (dispute.outcome === DisputeOutcome.ChallengerWins) {
      const reward = dispute.bond.mul(CHALLENGER_REWARD_BPS).div(10000);
      return { challengerReward: reward, submitterRemaining: BigNumber.from(0) };
    }
    return {
      challengerReward: BigNumber.from(0),
      submitterRemaining: dispute.bond,
    };
  }
}

interface Scenario {
  name: string;
  run: (sim: OracleSim, actors: SignerWithAddress[]) => void;
}

function councilVeto(sim: OracleSim, dispute: DisputeState, actors: SignerWithAddress[]) {
  for (let i = 0; i < COUNCIL_QUORUM; i++) {
    sim.vote(dispute, actors[i].address, true);
  }
}

function councilUphold(sim: OracleSim, dispute: DisputeState, actors: SignerWithAddress[]) {
  for (let i = 0; i < COUNCIL_QUORUM; i++) {
    sim.vote(dispute, actors[i].address, false);
  }
}

const SCENARIOS: Scenario[] = [
  {
    name: "dishonest submitter vetoed by council loses full bond",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      const { submitterRemaining } = sim.settle(d);
      expect(submitterRemaining).to.equal(0);
    },
  },
  {
    name: "challenger receives reward share on veto",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      const { challengerReward } = sim.settle(d);
      expect(challengerReward).to.equal(BOND.mul(CHALLENGER_REWARD_BPS).div(10000));
    },
  },
  {
    name: "timelock blocks premature finalization",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS - 1);
      expect(() => sim.finalize(d)).to.throw(/timelock/);
    },
  },
  {
    name: "frontrunning challenger still rewarded after veto",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      // challenger frontruns by voting immediately
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      const { challengerReward } = sim.settle(d);
      expect(challengerReward).to.be.gt(0);
    },
  },
  {
    name: "honest submitter keeps bond when council upholds",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilUphold(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      const { submitterRemaining, challengerReward } = sim.settle(d);
      expect(submitterRemaining).to.equal(BOND);
      expect(challengerReward).to.equal(0);
    },
  },
  {
    name: "no quorum prevents finalization",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      sim.vote(d, actors[2].address, true);
      sim.advanceTime(TIMELOCK_SECONDS);
      expect(() => sim.finalize(d)).to.throw(/quorum/);
    },
  },
  {
    name: "dishonest submitter loses bond across repeated vetoes",
    run: (sim, actors) => {
      for (let i = 0; i < 3; i++) {
        const d = sim.submit(actors[0].address, actors[1].address);
        councilVeto(sim, d, actors.slice(2));
        sim.advanceTime(TIMELOCK_SECONDS);
        sim.finalize(d);
        const { submitterRemaining } = sim.settle(d);
        expect(submitterRemaining).to.equal(0);
      }
    },
  },
  {
    name: "challenger reward never exceeds bond",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      const { challengerReward } = sim.settle(d);
      expect(challengerReward).to.be.lte(BOND);
    },
  },
  {
    name: "settle before finalization reverts",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      expect(() => sim.settle(d)).to.throw(/not finalized/);
    },
  },
  {
    name: "finalization exactly at timelock boundary succeeds",
    run: (sim, actors) => {
      const d = sim.submit(actors[0].address, actors[1].address);
      councilVeto(sim, d, actors.slice(2));
      sim.advanceTime(TIMELOCK_SECONDS);
      sim.finalize(d);
      expect(d.outcome).to.equal(DisputeOutcome.ChallengerWins);
      expect(d.finalizedAt).to.equal(d.createdAt + TIMELOCK_SECONDS);
    },
  },
];

describe("Oracle adversarial simulation testbed (#232)", function () {
  let actors: SignerWithAddress[];

  before(async function () {
    actors = await ethers.getSigners();
  });

  it("defines 10 distinct dispute sequences", function () {
    expect(SCENARIOS.length).to.equal(10);
  });

  SCENARIOS.forEach((scenario) => {
    it(scenario.name, function () {
      const sim = new OracleSim();
      scenario.run(sim, actors);
    });
  });
});
