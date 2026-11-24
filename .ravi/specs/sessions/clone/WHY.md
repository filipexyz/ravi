# Why session clone

Luís asked on 24/11 for a slash command that clones the current session into another channel with a chosen name. A conversation that grew a side topic should be able to move it to its own chat without losing context and without mixing it back.

Provider forks (`sessions runtime fork`) exist only for one runtime and are disabled on the host, so the clone seeds a new session with the recap instead: it works for every provider and every channel, and it copies only what the person could already read.
