# Package update and managed runtime reconciliation / WHY

Package replacement changes disk files, while running daemon and channel
runner processes retain their loaded code. Treating installation alone as an
update leaves native intake on an older build indefinitely. Explicit package
updates therefore own the restart of online siblings and verify their boot
identity. A status check or env write only reports drift because neither
operation asks to interrupt intake.
