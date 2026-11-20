use soroban_sdk::{contracttype, Address, Env, Symbol};

/// Bitmask flags controlling which operations are paused.
/// A set bit means the corresponding operation is PAUSED.
pub const PAUSE_BET: u32 = 1 << 0;
pub const PAUSE_CLAIM: u32 = 1 << 1;
pub const PAUSE_CREATE: u32 = 1 << 2;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseFlags {
    pub bits: u32,
}

impl PauseFlags {
    pub fn none() -> Self {
        PauseFlags { bits: 0 }
    }

    pub fn can_bet(&self) -> bool {
        self.bits & PAUSE_BET == 0
    }

    pub fn can_claim(&self) -> bool {
        self.bits & PAUSE_CLAIM == 0
    }

    pub fn can_create(&self) -> bool {
        self.bits & PAUSE_CREATE == 0
    }
}

const PAUSE_FLAGS_KEY: Symbol = Symbol::short("pause_flags");

pub fn get_pause_flags(env: &Env) -> PauseFlags {
    env.storage()
        .instance()
        .get(&PAUSE_FLAGS_KEY)
        .unwrap_or(PauseFlags::none())
}

pub fn set_pause_flags(env: &Env, flags: &PauseFlags) {
    env.storage().instance().set(&PAUSE_FLAGS_KEY, flags);
}

pub fn is_bet_paused(env: &Env) -> bool {
    !get_pause_flags(env).can_bet()
}

pub fn is_claim_paused(env: &Env) -> bool {
    !get_pause_flags(env).can_claim()
}

pub fn is_create_paused(env: &Env) -> bool {
    !get_pause_flags(env).can_create()
}

pub fn require_can_bet(env: &Env) {
    if is_bet_paused(env) {
        panic!("bet placement is paused");
    }
}

pub fn require_can_claim(env: &Env) {
    if is_claim_paused(env) {
        panic!("claim resolution is paused");
    }
}

pub fn require_can_create(env: &Env) {
    if is_create_paused(env) {
        panic!("market creation is paused");
    }
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&Symbol::short("admin"))
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&Symbol::short("admin"), admin);
}

pub fn require_admin(env: &Env) {
    let admin = get_admin(env).expect("admin not set");
    admin.require_auth();
}
