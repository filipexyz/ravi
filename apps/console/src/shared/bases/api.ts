// HTTP contract for Bases. The Console envelope lives under
// `/api/console/projects/<projectRef>/bases`, the CLI envelope under
// `/api/cli/projects/<projectRef>/bases`; both share these relative paths,
// methods, bodies, and responses. Action ids are stable for the future
// action registry.
//
// | method | path (relative to .../bases)                 | body                         | response                       | action id                              |
// |--------|-----------------------------------------------|------------------------------|--------------------------------|----------------------------------------|
// | GET    | ``                                            | ?includeArchived=1           | { bases: BaseSummary[] }       | console.bases.list                     |
// | POST   | ``                                            | BaseCreateInput              | BaseDetail (201)               | console.bases.create                   |
// | GET    | `/<base>`                                     |                              | BaseDetail                     | console.bases.get                      |
// | GET    | `/<base>/activity`                            | ?cursor                      | BaseActivityResponse           | console.bases.activity.list            |
// | PATCH  | `/<base>`                                     | BaseUpdateInput              | BaseSummary                    | console.bases.update                   |
// | POST   | `/<base>/archive` `/<base>/restore`           | { expectedVersion }          | BaseSummary                    | console.bases.archive / .restore       |
// | POST   | `/<base>/properties`                          | BaseCreatePropertyInput      | BasePropertyMutationResponse   | console.bases.properties.create        |
// | PATCH  | `/<base>/properties/<prop>`                   | BaseUpdatePropertyInput      | BasePropertyMutationResponse   | console.bases.properties.update        |
// | POST   | `/<base>/properties/<prop>/delete`            | { expectedSchemaVersion, confirm? } | BasePropertyMutationResponse | console.bases.properties.delete     |
// | POST   | `/<base>/properties/<prop>/restore`           | { expectedSchemaVersion }    | BasePropertyMutationResponse   | console.bases.properties.restore       |
// | POST   | `/<base>/rows/query`                          | BaseQueryRequest             | BaseQueryResponse              | console.bases.rows.query               |
// | POST   | `/<base>/rows/aggregate`                      | BaseAggregateRequest         | BaseAggregateResponse          | console.bases.rows.aggregate           |
// | POST   | `/<base>/rows`                                | BaseCreateRowsInput          | BaseRowWriteResponse | BaseRowBatchWriteResponse (201) | console.bases.rows.create |
// | GET    | `/<base>/rows/<row>`                          | ?includeArchived=1           | BaseRowWriteResponse (replay false) | console.bases.rows.get            |
// | PATCH  | `/<base>/rows/<row>`                          | BaseUpdateRowInput           | BaseRowWriteResponse           | console.bases.rows.update              |
// | POST   | `/<base>/rows/<row>/archive` `/restore`       | BaseRowLifecycleInput        | BaseRowWriteResponse           | console.bases.rows.archive / .restore  |
// | POST   | `/<base>/rows/<row>/purge`                    | { confirm: true }            | { purged: true, rowId }        | console.bases.rows.purge               |
// | GET    | `/<base>/rows/<row>/history`                  | ?cursor&limit                | BaseRowHistoryResponse         | console.bases.rows.history             |
// | POST   | `/<base>/rows/<row>/agent/<prop>`             | BaseAgentFillInput           | BaseRowWriteResponse           | console.bases.rows.agent.fill          |
// | POST   | `/<base>/rows/<row>/agent/<prop>/rerun`       | { idempotencyKey? }          | BaseRowWriteResponse           | console.bases.rows.agent.rerun         |
// | GET    | `/<base>/views`                               |                              | { views: Array<BaseView | BaseViewPublic> } | console.bases.views.list     |
// | POST   | `/<base>/views`                               | BaseCreateViewInput          | BaseView (201)                 | console.bases.views.create             |
// | GET    | `/<base>/views/<view>`                        |                              | BaseViewDescribeResponse       | console.bases.views.get                |
// | PATCH  | `/<base>/views/<view>`                        | BaseUpdateViewInput          | BaseView                       | console.bases.views.update             |
// | POST   | `/<base>/views/<view>/archive`                | { expectedVersion }          | BaseView                       | console.bases.views.archive            |
// | POST   | `/<base>/views/<view>/query`                  | BaseQueryRequest             | BaseQueryResponse              | console.bases.views.query              |
// | POST   | `/<base>/views/<view>/version`                | {}                           | BaseViewVersionResponse        | console.bases.views.version            |
// | POST   | `/<base>/views/<view>/rows`                   | BaseCreateRowsInput (single) | BaseRowWriteResponse (201)     | console.bases.views.rows.create        |
// | GET    | `/<base>/views/<view>/rows/<row>`             | ?asUserId                    | BaseRowWriteResponse           | console.bases.views.rows.get           |
// | PATCH  | `/<base>/views/<view>/rows/<row>`             | BaseUpdateRowInput           | BaseRowWriteResponse           | console.bases.views.rows.update        |
// | POST   | `/<base>/views/<view>/rows/<row>/archive`     | BaseRowLifecycleInput        | BaseRowWriteResponse           | console.bases.views.rows.archive       |
// | GET    | `/<base>/views/<view>/rows/<row>/history`     | ?cursor&limit                | BaseRowHistoryResponse         | console.bases.views.rows.history       |
// | GET    | `/<base>/charts`                              |                              | { charts: Array<BaseChart | BaseChartPublic> } | console.bases.charts.list   |
// | POST   | `/<base>/charts`                              | BaseCreateChartInput         | BaseChart (201)                | console.bases.charts.create            |
// | GET    | `/<base>/charts/<chart>`                      |                              | BaseChart | BaseChartPublic    | console.bases.charts.get               |
// | PATCH  | `/<base>/charts/<chart>`                      | BaseUpdateChartInput         | BaseChart                      | console.bases.charts.update            |
// | POST   | `/<base>/charts/<chart>/archive`              | { expectedVersion }          | BaseChart                      | console.bases.charts.archive           |
// | POST   | `/<base>/charts/<chart>/data`                 | {}                           | BaseChartDataResponse          | console.bases.charts.data              |
// | GET    | `/<base>/subscriptions`                       |                              | { subscriptions: BaseSubscription[] } | console.bases.subscriptions.list |
// | POST   | `/<base>/subscriptions`                       | BaseSubscriptionCreateInput (CLI envelope only) | BaseSubscription (201; 200 for the same filter) | console.bases.subscriptions.create |
// | POST   | `/<base>/subscriptions/<id>/revoke`           | {}                           | BaseSubscription               | console.bases.subscriptions.revoke     |
//
// `<base>` is a base uuid or slug; `<prop>` a property id or key; `<view>`,
// `<chart>`, `<row>` are uuids. Row writes and the base, property, view, and
// chart creates accept the `Idempotency-Key` header as an alternative to
// `idempotencyKey` in the body.
//
// Errors: `BaseApiErrorBody` on the Console envelope; on the CLI envelope
// `{ error: { code, message, requestId, details?: BaseApiErrorBody } }`.

export const BASES_ACTION_IDS = [
  "console.bases.list",
  "console.bases.create",
  "console.bases.get",
  "console.bases.activity.list",
  "console.bases.update",
  "console.bases.archive",
  "console.bases.restore",
  "console.bases.properties.create",
  "console.bases.properties.update",
  "console.bases.properties.delete",
  "console.bases.properties.restore",
  "console.bases.rows.query",
  "console.bases.rows.aggregate",
  "console.bases.rows.create",
  "console.bases.rows.get",
  "console.bases.rows.update",
  "console.bases.rows.archive",
  "console.bases.rows.restore",
  "console.bases.rows.purge",
  "console.bases.rows.history",
  "console.bases.rows.agent.fill",
  "console.bases.rows.agent.rerun",
  "console.bases.views.list",
  "console.bases.views.create",
  "console.bases.views.get",
  "console.bases.views.update",
  "console.bases.views.archive",
  "console.bases.views.query",
  "console.bases.views.version",
  "console.bases.views.rows.create",
  "console.bases.views.rows.get",
  "console.bases.views.rows.update",
  "console.bases.views.rows.archive",
  "console.bases.views.rows.history",
  "console.bases.charts.list",
  "console.bases.charts.create",
  "console.bases.charts.get",
  "console.bases.charts.update",
  "console.bases.charts.archive",
  "console.bases.charts.data",
  "console.bases.subscriptions.list",
  "console.bases.subscriptions.create",
  "console.bases.subscriptions.revoke",
] as const;
export type BasesActionId = (typeof BASES_ACTION_IDS)[number];
