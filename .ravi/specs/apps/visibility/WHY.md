# App Visibility / WHY

App manifests disclose operational capability: executable paths, SDK routes,
permission requirements, installed product features, and possible actions.
Discovery is therefore an authorization decision, not a harmless catalog read.

The visibility boundary keeps runtime agents from learning about apps they
cannot use, while preserving direct local operator inspection for unsourced CLI
debugging.
