# Why

Jarvis should be able to use Ravi as an execution runtime without making Ravi
the owner of RBBT product semantics.

The important boundary is not a technical HTTP/API boundary. It is a semantic
boundary between cognitive bounded contexts. When one product or agent asks
another to reason or act, the request must preserve the sender's ubiquitous
language, assumptions, constraints, claims, SAL projection, semantic event refs
and bridge contract refs.

Ravi should validate and transport that envelope because it owns runtime
execution, tracing, tools, approvals and provider adaptation. Ravi should not
interpret the envelope because the product/framework owns the semantics.

This keeps the first Jarvis integration narrow while leaving room for other
products to reuse the same runtime contract later.
