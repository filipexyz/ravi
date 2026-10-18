# Context Guardian Contract v0

O contrato minimo do `context guardian` fica no nivel do agent, em `agent.defaults.contextGuardians`.

## Boundary

- `ContextGuardian` guarda identidade, objetivo estavel, contexto-alvo e criterio de escalacao.
- `TaskTrigger` decide quando a verificacao recorrente roda.
- `RecurringTask` e a unidade operacional: carrega instrucao, estado da recorrencia e ultimo output estruturado.
- O `trigger` pode reutilizar shape de agenda (`every` ou `cron`), mas o timer nao e a primitive principal. A primitive principal continua sendo a `recurring task`.

## Agent Storage

```json
{
  "contextGuardians": {
    "agentId": "dev",
    "guardians": [
      {
        "id": "work-execution",
        "agentId": "dev",
        "objective": "Keep work execution moving with low-noise escalation",
        "stableContractRef": "wish:context-guardian-agents/work-execution",
        "contextTarget": {
          "agentId": "dev",
          "scope": "work_execution",
          "surfaces": ["tasks", "sessions"]
        },
        "escalationPolicy": {
          "targetSession": "agent:main:main",
          "notifyOn": [
            "front_switch_without_closure",
            "follow_up_overdue",
            "priority_drift"
          ],
          "minimumSeverity": "medium"
        },
        "enabled": true
      }
    ],
    "recurringTasks": [
      {
        "id": "work-execution-loop",
        "guardianId": "work-execution",
        "agentId": "dev",
        "title": "Review work execution drift",
        "instruction": "Inspect active work, detect drift, and escalate only when actionable.",
        "trigger": {
          "kind": "schedule",
          "schedule": { "type": "every", "every": 1800000 },
          "enabled": true
        },
        "execution": {
          "agentId": "dev",
          "sessionTarget": "task"
        },
        "state": {
          "status": "active",
          "runCount": 0
        }
      }
    ]
  }
}
```

## v0 Rules

- `scope` fica fechado em `work_execution`.
- `RecurringTask` so aceita recorrencia real (`every` ou `cron`), nao `at` one-shot.
- Cada guardian precisa possuir ao menos uma `recurring task`.
- `lastOutput` precisa carregar drifts estruturados quando o outcome for `alert`.
- `iterationContract` ainda nao ganha schema aqui; o Group 1 deixa apenas um `iterationContractRef` para o Group 2 materializar.

## Fora Do v0

- wiring de scheduler/runner
- schema completo do `iteration contract`
- coordenação multi-agent
- intervencao direta no Luis fora da `main`
