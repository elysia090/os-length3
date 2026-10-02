#include <stdio.h>
#include <vm/resource.h>

static int failed;
#define EXPECT(expression) do { \
    if (!(expression)) { \
        fprintf(stderr, "resource: line %u\n", (unsigned)__LINE__); \
        ++failed; \
    } \
} while (0)

static vm_resource_grant grant(void)
{
    vm_resource_grant value = { 0 };
    value.address = (vm_resource_address){ .authority = { 1u, 2u },
        .workspace = { 3u, 4u }, .resource = 5u, .generation = 6u,
        .revision = 7u, .lane = 0u };
    value.first = 100u;
    value.extent = 4096u;
    value.maximum_bytes = 256u;
    value.rights = VM_RESOURCE_READ | VM_RESOURCE_WRITE;
    value.kind = VM_RESOURCE_OBJECT;
    return value;
}

static int same_address(const vm_resource_address *a,
                         const vm_resource_address *b)
{
    return a->authority[0] == b->authority[0]
        && a->authority[1] == b->authority[1]
        && a->workspace[0] == b->workspace[0]
        && a->workspace[1] == b->workspace[1]
        && a->resource == b->resource && a->generation == b->generation
        && a->revision == b->revision && a->lane == b->lane;
}

static int same_gate(const vm_resource_gate *a, const vm_resource_gate *b)
{
    return same_address(&a->grant.address, &b->grant.address)
        && a->grant.first == b->grant.first && a->grant.extent == b->grant.extent
        && a->grant.maximum_bytes == b->grant.maximum_bytes
        && a->grant.rights == b->grant.rights && a->grant.kind == b->grant.kind
        && a->issued == b->issued && a->pending == b->pending
        && a->completed == b->completed && a->cancelled == b->cancelled
        && a->pending_bytes == b->pending_bytes
        && a->completed_bytes == b->completed_bytes
        && a->initialized == b->initialized && a->live == b->live;
}

static vm_resource_request request(const vm_resource_grant *g)
{
    return (vm_resource_request){ g->address, g->first, 32u, VM_RESOURCE_READ };
}

static void lifecycle(void)
{
    vm_resource_gate gate = { 0 }, saved;
    vm_resource_grant g = grant();
    vm_resource_request r = request(&g);
    vm_resource_ticket first = { 0 }, second = { 0 }, altered;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&gate, &r, &first) == VM_RESOURCE_OK);
    EXPECT(first.sequence == 1u && same_address(&first.address, &g.address));
    saved = gate;
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_ERROR_BUSY);
    EXPECT(same_gate(&gate, &saved) && second.sequence == 0u);
    EXPECT(vm_resource_complete(&gate, &first, 33u) == VM_RESOURCE_ERROR_RANGE);
    EXPECT(same_gate(&gate, &saved));
    for (pl_u32 field = 0u; field < 9u; ++field) {
        altered = first;
        switch (field) {
        case 0: altered.address.authority[0] ^= 1u; break;
        case 1: altered.address.authority[1] ^= 1u; break;
        case 2: altered.address.workspace[0] ^= 1u; break;
        case 3: altered.address.workspace[1] ^= 1u; break;
        case 4: ++altered.address.resource; break;
        case 5: ++altered.address.generation; break;
        case 6: ++altered.address.revision; break;
        case 7: ++altered.address.lane; break;
        default: ++altered.sequence; break;
        }
        EXPECT(vm_resource_complete(&gate, &altered, 32u) == VM_RESOURCE_ERROR_STALE);
        EXPECT(vm_resource_cancel(&gate, &altered) == VM_RESOURCE_ERROR_STALE);
        EXPECT(same_gate(&gate, &saved));
    }
    EXPECT(vm_resource_complete(&gate, &first, 16u) == VM_RESOURCE_OK);
    saved = gate;
    EXPECT(vm_resource_complete(&gate, &first, 16u) == VM_RESOURCE_DUPLICATE);
    EXPECT(vm_resource_complete(&gate, &first, 15u) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(same_gate(&gate, &saved));
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_OK);
    EXPECT(second.sequence == 2u);
    saved = gate;
    EXPECT(vm_resource_complete(&gate, &first, 16u) == VM_RESOURCE_DUPLICATE);
    EXPECT(same_gate(&gate, &saved));
    EXPECT(vm_resource_cancel(&gate, &second) == VM_RESOURCE_OK);
    EXPECT(vm_resource_cancel(&gate, &second) == VM_RESOURCE_DUPLICATE);
    EXPECT(vm_resource_complete(&gate, &second, 32u) == VM_RESOURCE_ERROR_STALE);
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_OK);
    EXPECT(second.sequence == 3u);
    EXPECT(vm_resource_revoke(&gate) == VM_RESOURCE_OK);
    EXPECT(vm_resource_revoke(&gate) == VM_RESOURCE_DUPLICATE);
    EXPECT(vm_resource_complete(&gate, &second, 32u) == VM_RESOURCE_ERROR_STALE);
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_ERROR_DENIED);
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_ERROR_STALE);
    ++g.address.revision;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_ERROR_STALE);
    r = request(&g);
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_OK);
    EXPECT(second.sequence == 4u);
    ++g.address.generation;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
    EXPECT(vm_resource_complete(&gate, &second, 32u) == VM_RESOURCE_ERROR_STALE);
    r = request(&g);
    EXPECT(vm_resource_begin(&gate, &r, &second) == VM_RESOURCE_OK);
    EXPECT(second.sequence == 5u);
    EXPECT(vm_resource_complete(&gate, &second, 0u) == VM_RESOURCE_OK);
}

static void replacement_and_limits(void)
{
    vm_resource_gate gate = { 0 }, saved;
    vm_resource_grant g = grant(), bad;
    vm_resource_request r = request(&g);
    vm_resource_ticket ticket = { 0 };
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&gate, &r, &ticket) == VM_RESOURCE_OK);
    saved = gate;
    for (pl_u32 field = 0u; field < 10u; ++field) {
        bad = g;
        ++bad.address.revision;
        switch (field) {
        case 0: ++bad.address.authority[0]; break;
        case 1: ++bad.address.workspace[1]; break;
        case 2: ++bad.address.resource; break;
        case 3: --bad.address.generation; break;
        case 4: bad.address.revision = g.address.revision - 1u; break;
        case 5: bad.kind = VM_RESOURCE_FILE; break;
        case 6: bad.first = ~0ull; bad.extent = 2u; break;
        case 7: bad.maximum_bytes = 0u; break;
        case 8: bad.rights = 8u; break;
        default: ++bad.address.lane; break;
        }
        EXPECT(vm_resource_bind(&gate, &bad) < 0);
        EXPECT(same_gate(&gate, &saved));
    }
    EXPECT(vm_resource_cancel(&gate, &ticket) == VM_RESOURCE_OK);
    gate.issued = ~0ull - 1u;
    EXPECT(vm_resource_begin(&gate, &r, &ticket) == VM_RESOURCE_OK);
    EXPECT(ticket.sequence == ~0ull);
    EXPECT(vm_resource_complete(&gate, &ticket, 32u) == VM_RESOURCE_OK);
    saved = gate;
    EXPECT(vm_resource_begin(&gate, &r, &ticket) == VM_RESOURCE_ERROR_EXHAUSTED);
    ++g.address.generation;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_ERROR_EXHAUSTED);
    EXPECT(same_gate(&gate, &saved));

    gate = (vm_resource_gate){ 0 };
    g = grant();
    g.address.generation = ~0ull;
    g.address.revision = ~0ull;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
    saved = gate;
    g.address.generation = 1u;
    g.address.revision = 1u;
    EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_ERROR_STALE);
    EXPECT(same_gate(&gate, &saved));
    EXPECT(vm_resource_bind(NULL, &g) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_bind(&gate, NULL) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_begin(NULL, &r, &ticket) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_begin(&gate, NULL, &ticket) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_begin(&gate, &r, NULL) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_complete(NULL, &ticket, 0u) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_cancel(&gate, NULL) == VM_RESOURCE_ERROR_INPUT);
    EXPECT(vm_resource_revoke(NULL) == VM_RESOURCE_ERROR_INPUT);
}

static void parallel_lanes(void)
{
    vm_resource_gate first = { 0 }, second = { 0 }, saved;
    vm_resource_grant a = grant(), b = grant();
    vm_resource_request ra = request(&a), rb = request(&b);
    vm_resource_ticket ta = { 0 }, tb = { 0 };
    b.address.lane = 1u;
    rb = request(&b);
    EXPECT(vm_resource_bind(&first, &a) == VM_RESOURCE_OK);
    EXPECT(vm_resource_bind(&second, &b) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&first, &ra, &ta) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&second, &rb, &tb) == VM_RESOURCE_OK);
    EXPECT(ta.sequence == tb.sequence);
    saved = second;
    EXPECT(vm_resource_complete(&second, &ta, ra.bytes) == VM_RESOURCE_ERROR_STALE);
    EXPECT(same_gate(&second, &saved));
    EXPECT(vm_resource_complete(&first, &ta, ra.bytes) == VM_RESOURCE_OK);
    EXPECT(vm_resource_complete(&second, &tb, rb.bytes) == VM_RESOURCE_OK);
}

static void authority_restart(void)
{
    vm_resource_gate old = { 0 }, fresh = { 0 }, saved;
    vm_resource_grant previous = grant(), replacement = grant();
    vm_resource_request r = request(&previous);
    vm_resource_ticket old_ticket = { 0 }, fresh_ticket = { 0 };
    EXPECT(vm_resource_bind(&old, &previous) == VM_RESOURCE_OK);
    EXPECT(vm_resource_begin(&old, &r, &old_ticket) == VM_RESOURCE_OK);
    replacement.address.authority[1] += 1u;
    EXPECT(vm_resource_bind(&fresh, &replacement) == VM_RESOURCE_OK);
    r = request(&replacement);
    EXPECT(vm_resource_begin(&fresh, &r, &fresh_ticket) == VM_RESOURCE_OK);
    EXPECT(old_ticket.sequence == fresh_ticket.sequence);
    saved = fresh;
    EXPECT(vm_resource_complete(&fresh, &old_ticket, r.bytes) == VM_RESOURCE_ERROR_STALE);
    EXPECT(same_gate(&fresh, &saved));
    EXPECT(vm_resource_complete(&fresh, &fresh_ticket, r.bytes) == VM_RESOURCE_OK);
}

static pl_u64 random_word(pl_u64 *state)
{
    *state ^= *state << 13u;
    *state ^= *state >> 7u;
    *state ^= *state << 17u;
    return *state;
}

static void ranges_and_directions(void)
{
    pl_u64 seed = 0x27f5a489d76c0391ull;
    __extension__ typedef unsigned __int128 wide;
    for (pl_u32 i = 0u; i < 100000u; ++i) {
        vm_resource_gate gate = { 0 }, saved;
        vm_resource_grant g = grant();
        vm_resource_ticket ticket = { 0 };
        vm_resource_request r;
        pl_u64 available;
        int expected;
        g.first = random_word(&seed);
        available = ~0ull - g.first;
        g.extent = (random_word(&seed) & 65535u) + 1u;
        if (g.extent > available) { g.first = 0u; }
        g.maximum_bytes = (pl_u32)(random_word(&seed) % 4096u) + 1u;
        g.rights = (pl_u32)(random_word(&seed) % 3u) + 1u;
        EXPECT(vm_resource_bind(&gate, &g) == VM_RESOURCE_OK);
        r = request(&g);
        r.offset = (i & 1u) ? g.first : random_word(&seed);
        r.bytes = (pl_u32)(random_word(&seed) % 8192u);
        r.right = (pl_u32)(random_word(&seed) % 8u);
        if ((i % 7u) == 0u) ++r.address.revision;
        expected = !same_address(&r.address, &g.address) ? VM_RESOURCE_ERROR_STALE
            : (r.right != VM_RESOURCE_READ && r.right != VM_RESOURCE_WRITE)
                || !(g.rights & r.right) ? VM_RESOURCE_ERROR_DENIED
            : !r.bytes || r.bytes > g.maximum_bytes
                || (wide)r.offset < g.first
                || (wide)r.offset + r.bytes > (wide)g.first + g.extent
                ? VM_RESOURCE_ERROR_RANGE : VM_RESOURCE_OK;
        saved = gate;
        EXPECT(vm_resource_begin(&gate, &r, &ticket) == expected);
        if (expected == VM_RESOURCE_OK) {
            EXPECT(vm_resource_complete(&gate, &ticket, r.bytes) == VM_RESOURCE_OK);
        } else {
            EXPECT(same_gate(&gate, &saved));
            EXPECT(ticket.sequence == 0u);
        }
    }
}

int main(void)
{
    lifecycle();
    replacement_and_limits();
    parallel_lanes();
    authority_restart();
    ranges_and_directions();
    if (failed) return 1;
    puts("Resource gate: green (100000 range/direction cases, revoke/cancel/rebind/ABA/duplicate/exhaustion)");
    puts("Linux boot, actual host consent, durability and adapter integration: not established by this test");
    return 0;
}
