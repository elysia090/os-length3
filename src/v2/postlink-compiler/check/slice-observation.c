#include "internal/plan.h"

#include <stdio.h>

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

static int spell(const pl_plan *plan,
                 pl_u8 topology[512], pl_u32 *topology_bytes,
                 pl_u8 parameters[512], pl_u32 *parameter_bytes)
{
    pl_u32 measured_topology = 0u, measured_parameters = 0u;
    int status = pl_plan_topology_measure(plan, &measured_topology);
    if (!status)
        status = pl_plan_parameters_measure(plan, &measured_parameters);
    if (!status)
        status = pl_plan_topology_write(
            plan, topology, 512u, topology_bytes);
    if (!status)
        status = pl_plan_parameters_write(
            plan, parameters, 512u, parameter_bytes);
    if (!status && (measured_topology != *topology_bytes
            || measured_parameters != *parameter_bytes))
        status = PL_ERROR_PLAN;
    return status;
}

int main(void)
{
    pl_node node_a[] = { { 41u, 0u, 2u } };
    pl_operand argument_a[] = {
        { PL_OPERAND_LOCAL, 4u }, { PL_OPERAND_CONST, 7u },
    };
    pl_operand local_a[] = {
        { PL_OPERAND_NODE, 1u },
        { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_LOCAL, 2u },
    };
    pl_u32 wave_offset_a[] = { 0u, 1u };
    pl_u32 wave_value_a[] = { 1u };
    pl_plan plan_a = {
        11u, 20u, 21u, 1u, 0u, 1u,
        node_a, 1u, argument_a, 2u,
        0, 0u, local_a, 3u, wave_offset_a, wave_value_a,
    };

    pl_node node_b[] = { { 41u, 0u, 2u } };
    pl_operand argument_b[] = {
        { PL_OPERAND_LOCAL, 9u }, { PL_OPERAND_CONST, 101u },
    };
    pl_operand local_b[] = {
        { PL_OPERAND_LOCAL, 0u },
        { PL_OPERAND_LOCAL, 1u },
        { PL_OPERAND_NODE, 1u },
    };
    pl_u32 wave_offset_b[] = { 0u, 0u, 1u };
    pl_u32 wave_value_b[] = { 1u };
    pl_plan plan_b = {
        99u, 300u, 304u, 4u, 0u, 2u,
        node_b, 1u, argument_b, 2u,
        0, 0u, local_b, 3u, wave_offset_b, wave_value_b,
    };

    pl_u8 topology_a[512], topology_b[512], topology_changed[512];
    pl_u8 parameter_a[512], parameter_b[512], parameter_changed[512];
    pl_u32 ta = 0u, tb = 0u, tc = 0u, pa = 0u, pb = 0u, pc = 0u;
    int status = spell(
        &plan_a, topology_a, &ta, parameter_a, &pa);
    if (!status)
        status = spell(
            &plan_b, topology_b, &tb, parameter_b, &pb);
    if (!status && (ta != tb || !same_bytes(topology_a, topology_b, ta)
            || (pa == pb && same_bytes(parameter_a, parameter_b, pa))))
        status = PL_ERROR_PLAN;

    node_b[0].opcode = 42u;
    if (!status)
        status = spell(
            &plan_b, topology_changed, &tc,
            parameter_changed, &pc);
    if (!status && (ta == tc
            && same_bytes(topology_a, topology_changed, ta)))
        status = PL_ERROR_PLAN;

    if (status) {
        fprintf(stderr, "pure-slice topology spelling: RED (%d)\n", status);
        return 1;
    }
    printf("pure-slice topology spelling: green "
           "(source/waves/parameters erased from shared topology)\n");
    return 0;
}
