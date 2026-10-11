// job_rules_bridge.zig -- the wasm boundary of gHashTag/t27 specs/network/job_rules.t27, and nothing
// else. job_rules.zig is `t27c gen specs/network/job_rules.t27`, verbatim. Each export below turns
// (pointer, length) pairs into the slices the generated function takes and returns its answer as is:
// no branch, no constant, no decision lives in this file. The runner writes the text into the module's
// memory past its built size (queen-card-wasm.ts put()).
const R = @import("job_rules.zig");

fn s(p: [*]const u8, n: usize) []const u8 {
    return p[0..n];
}

export fn receipt_auth(mp: [*]const u8, mn: usize, jp: [*]const u8, jn: usize, ip: [*]const u8, in_: usize, kp: [*]const u8, kn: usize, sp: [*]const u8, sn: usize, cp: [*]const u8, cn: usize) u8 {
    return R.receipt_auth(s(mp, mn), s(jp, jn), s(ip, in_), s(kp, kn), s(sp, sn), s(cp, cn));
}

export fn receipt_auth_level(mp: [*]const u8, mn: usize, jp: [*]const u8, jn: usize, ip: [*]const u8, in_: usize, kp: [*]const u8, kn: usize, sp: [*]const u8, sn: usize, cp: [*]const u8, cn: usize) u8 {
    return R.receipt_auth_level(s(mp, mn), s(jp, jn), s(ip, in_), s(kp, kn), s(sp, sn), s(cp, cn));
}

export fn message_well_formed(mp: [*]const u8, mn: usize) bool {
    return R.message_well_formed(s(mp, mn));
}

export fn nonce_bytes(mp: [*]const u8, mn: usize) u8 {
    return R.nonce_bytes(s(mp, mn));
}

export fn results_agree(ap: [*]const u8, an: usize, bp: [*]const u8, bn: usize) bool {
    return R.results_agree(s(ap, an), s(bp, bn));
}

export fn key_operator(kp: [*]const u8, kn: usize) u32 {
    return R.key_operator(s(kp, kn));
}

export fn challenge_ok(cp: [*]const u8, cn: usize) bool {
    return R.challenge_ok(s(cp, cn));
}

export fn independent_votes(kp: [*]const u8, kn: usize) u32 {
    return R.independent_votes(s(kp, kn));
}

export fn distinct_keys(kp: [*]const u8, kn: usize) u32 {
    return R.distinct_keys(s(kp, kn));
}

export fn quorum_verdict(votes: u32, agree: bool) u8 {
    return R.quorum_verdict(votes, agree);
}

export fn job_nonce(jp: [*]const u8, jn: usize) u32 {
    return R.job_nonce(s(jp, jn));
}

export fn settle_outcome(qv: u8, operator: u32, nonce: u32, prior: bool) u8 {
    return R.settle_outcome(qv, operator, nonce, prior);
}

export fn settle_credit_mtri(qv: u8, operator: u32, nonce: u32, prior: bool) u64 {
    return R.settle_credit_mtri(qv, operator, nonce, prior);
}

export fn credit_state(outcome: u8, minutes_since: u32, challenge_open: bool) u8 {
    return R.credit_state(outcome, minutes_since, challenge_open);
}

export fn settle_verdict(qv: u8) u8 {
    return R.settle_verdict(qv);
}
