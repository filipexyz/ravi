// GENERATED FILE — DO NOT EDIT.
// Run `bun run console:sdk` to regenerate.
// Drift is detected by `bun run console:sdk:check` (CI).

/**
 * JSON Schema constants for every registry command. Emitted as `as const`
 * so callers can pair them with `ajv` / `zod-from-json-schema` / etc when
 * client-side validation is desired.
 */

export type SdkJsonSchema = Record<string, unknown>;

/** JSON Schema for the input body of `associations.approve`. */
export const AssociationsApproveInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "associationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "challenge": {
          "maxLength": 256,
          "minLength": 32,
          "type": "string"
        },
        "fingerprint": {
          "pattern": "^[a-f0-9]{64}$",
          "type": "string"
        },
        "name": {
          "maxLength": 120,
          "minLength": 1,
          "type": "string"
        },
        "operationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "associationId",
        "challenge",
        "fingerprint",
        "name"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `associations.approve`. */
export const AssociationsApproveReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "lastSeenAt": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "name": {
      "type": "string"
    },
    "platform": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "status": {
      "enum": [
        "pending",
        "online",
        "offline",
        "revoked"
      ],
      "type": "string"
    }
  },
  "required": [
    "id",
    "name",
    "platform",
    "status",
    "revision",
    "lastSeenAt"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `associations.show`. */
export const AssociationsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "associationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "challenge": {
          "maxLength": 256,
          "minLength": 32,
          "type": "string"
        }
      },
      "required": [
        "associationId",
        "challenge"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `associations.show`. */
export const AssociationsShowReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "expiresAt": {
      "type": "string"
    },
    "fingerprint": {
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "installationId": {
      "anyOf": [
        {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "name": {
      "type": "string"
    },
    "platform": {
      "type": "string"
    },
    "status": {
      "enum": [
        "pending",
        "approved",
        "expired",
        "denied"
      ],
      "type": "string"
    }
  },
  "required": [
    "id",
    "name",
    "platform",
    "fingerprint",
    "expiresAt",
    "status",
    "installationId"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `channels.list`. */
export const ChannelsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `channels.list`. */
export const ChannelsListReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "channels": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "credentialConnection": {
            "type": "string"
          },
          "enabled": {
            "type": "boolean"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "identity": {
            "additionalProperties": false,
            "properties": {
              "botUserId": {
                "pattern": "^[UW][A-Z0-9]+$",
                "type": "string"
              },
              "teamId": {
                "pattern": "^T[A-Z0-9]+$",
                "type": "string"
              }
            },
            "required": [
              "teamId",
              "botUserId"
            ],
            "type": "object"
          },
          "installationId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "operationId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "status": {
            "enum": [
              "queued",
              "delivered",
              "succeeded",
              "failed",
              "uncertain",
              "cancelled"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "installationId",
          "identity",
          "credentialConnection",
          "enabled",
          "operationId",
          "status"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "channels"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `installations.list`. */
export const InstallationsListInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `installations.list`. */
export const InstallationsListReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "installations": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "lastSeenAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "platform": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "status": {
            "enum": [
              "pending",
              "online",
              "offline",
              "revoked"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "platform",
          "status",
          "revision",
          "lastSeenAt"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "installations"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `installations.revoke`. */
export const InstallationsRevokeInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "expectedRevision": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "installationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "operationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "installationId",
        "expectedRevision"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `installations.revoke`. */
export const InstallationsRevokeReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "lastSeenAt": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "name": {
      "type": "string"
    },
    "platform": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "status": {
      "enum": [
        "pending",
        "online",
        "offline",
        "revoked"
      ],
      "type": "string"
    }
  },
  "required": [
    "id",
    "name",
    "platform",
    "status",
    "revision",
    "lastSeenAt"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `onboarding.finish`. */
export const OnboardingFinishInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "snapshot": {
          "pattern": "^[a-f0-9]{64}$",
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "snapshot"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `onboarding.finish`. */
export const OnboardingFinishReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "completed": {
      "type": "boolean"
    },
    "installations": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "lastSeenAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "platform": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "status": {
            "enum": [
              "pending",
              "online",
              "offline",
              "revoked"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "platform",
          "status",
          "revision",
          "lastSeenAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "ready": {
      "type": "boolean"
    },
    "snapshot": {
      "type": "string"
    }
  },
  "required": [
    "completed",
    "ready",
    "installations",
    "snapshot"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `onboarding.state`. */
export const OnboardingStateInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {},
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `onboarding.state`. */
export const OnboardingStateReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "completed": {
      "type": "boolean"
    },
    "installations": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "lastSeenAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "name": {
            "type": "string"
          },
          "platform": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "revision": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "status": {
            "enum": [
              "pending",
              "online",
              "offline",
              "revoked"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "platform",
          "status",
          "revision",
          "lastSeenAt"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "ready": {
      "type": "boolean"
    },
    "snapshot": {
      "type": "string"
    }
  },
  "required": [
    "completed",
    "ready",
    "installations",
    "snapshot"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `operations.enqueue`. */
export const OperationsEnqueueInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "command": {
          "oneOf": [
            {
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "const": "health",
                  "type": "string"
                }
              },
              "required": [
                "kind"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "kind": {
                  "const": "channels.inspect",
                  "type": "string"
                }
              },
              "required": [
                "kind"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "credentialConnection": {
                  "maxLength": 200,
                  "minLength": 1,
                  "type": "string"
                },
                "enabled": {
                  "type": "boolean"
                },
                "identity": {
                  "additionalProperties": false,
                  "properties": {
                    "botUserId": {
                      "pattern": "^[UW][A-Z0-9]+$",
                      "type": "string"
                    },
                    "teamId": {
                      "pattern": "^T[A-Z0-9]+$",
                      "type": "string"
                    }
                  },
                  "required": [
                    "teamId",
                    "botUserId"
                  ],
                  "type": "object"
                },
                "kind": {
                  "const": "channel.configure",
                  "type": "string"
                },
                "name": {
                  "pattern": "^[a-zA-Z0-9_-]{1,120}$",
                  "type": "string"
                },
                "provider": {
                  "const": "slack",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "name",
                "provider",
                "credentialConnection",
                "enabled",
                "identity"
              ],
              "type": "object"
            }
          ]
        },
        "installationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "operationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "operationId",
        "installationId",
        "command"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `operations.enqueue`. */
export const OperationsEnqueueReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "createdAt": {
      "type": "string"
    },
    "error": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "installationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "result": {
      "anyOf": [
        {
          "oneOf": [
            {
              "additionalProperties": false,
              "properties": {
                "health": {
                  "additionalProperties": false,
                  "properties": {
                    "channels": {
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "credentialConnection": {
                            "anyOf": [
                              {
                                "maxLength": 200,
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "enabled": {
                            "type": "boolean"
                          },
                          "name": {
                            "maxLength": 120,
                            "minLength": 1,
                            "type": "string"
                          },
                          "provider": {
                            "maxLength": 80,
                            "minLength": 1,
                            "type": "string"
                          }
                        },
                        "required": [
                          "name",
                          "provider",
                          "enabled",
                          "credentialConnection"
                        ],
                        "type": "object"
                      },
                      "maxItems": 500,
                      "type": "array"
                    },
                    "platform": {
                      "type": "string"
                    },
                    "version": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "version",
                    "platform",
                    "channels"
                  ],
                  "type": "object"
                },
                "kind": {
                  "const": "health",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "health"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "channels": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "credentialConnection": {
                        "anyOf": [
                          {
                            "maxLength": 200,
                            "type": "string"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "enabled": {
                        "type": "boolean"
                      },
                      "name": {
                        "maxLength": 120,
                        "minLength": 1,
                        "type": "string"
                      },
                      "provider": {
                        "maxLength": 80,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "name",
                      "provider",
                      "enabled",
                      "credentialConnection"
                    ],
                    "type": "object"
                  },
                  "maxItems": 500,
                  "type": "array"
                },
                "connections": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "available": {
                        "type": "boolean"
                      },
                      "connection": {
                        "type": "string"
                      },
                      "identity": {
                        "anyOf": [
                          {
                            "additionalProperties": false,
                            "properties": {
                              "botUserId": {
                                "pattern": "^[UW][A-Z0-9]+$",
                                "type": "string"
                              },
                              "teamId": {
                                "pattern": "^T[A-Z0-9]+$",
                                "type": "string"
                              }
                            },
                            "required": [
                              "teamId",
                              "botUserId"
                            ],
                            "type": "object"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "connection",
                      "identity",
                      "available"
                    ],
                    "type": "object"
                  },
                  "maxItems": 100,
                  "type": "array"
                },
                "kind": {
                  "const": "channels.inspect",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "connections",
                "channels"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "channel": {
                  "additionalProperties": false,
                  "properties": {
                    "credentialConnection": {
                      "anyOf": [
                        {
                          "maxLength": 200,
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "enabled": {
                      "type": "boolean"
                    },
                    "name": {
                      "maxLength": 120,
                      "minLength": 1,
                      "type": "string"
                    },
                    "provider": {
                      "maxLength": 80,
                      "minLength": 1,
                      "type": "string"
                    }
                  },
                  "required": [
                    "name",
                    "provider",
                    "enabled",
                    "credentialConnection"
                  ],
                  "type": "object"
                },
                "kind": {
                  "const": "channel.configure",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "channel"
              ],
              "type": "object"
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "status": {
      "enum": [
        "queued",
        "delivered",
        "succeeded",
        "failed",
        "uncertain",
        "cancelled"
      ],
      "type": "string"
    }
  },
  "required": [
    "id",
    "installationId",
    "status",
    "createdAt",
    "result",
    "error"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `operations.latest`. */
export const OperationsLatestInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "installationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "installationId"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `operations.latest`. */
export const OperationsLatestReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "operation": {
      "anyOf": [
        {
          "additionalProperties": false,
          "properties": {
            "createdAt": {
              "type": "string"
            },
            "error": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "id": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              "type": "string"
            },
            "installationId": {
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
              "type": "string"
            },
            "result": {
              "anyOf": [
                {
                  "oneOf": [
                    {
                      "additionalProperties": false,
                      "properties": {
                        "health": {
                          "additionalProperties": false,
                          "properties": {
                            "channels": {
                              "items": {
                                "additionalProperties": false,
                                "properties": {
                                  "credentialConnection": {
                                    "anyOf": [
                                      {
                                        "maxLength": 200,
                                        "type": "string"
                                      },
                                      {
                                        "type": "null"
                                      }
                                    ]
                                  },
                                  "enabled": {
                                    "type": "boolean"
                                  },
                                  "name": {
                                    "maxLength": 120,
                                    "minLength": 1,
                                    "type": "string"
                                  },
                                  "provider": {
                                    "maxLength": 80,
                                    "minLength": 1,
                                    "type": "string"
                                  }
                                },
                                "required": [
                                  "name",
                                  "provider",
                                  "enabled",
                                  "credentialConnection"
                                ],
                                "type": "object"
                              },
                              "maxItems": 500,
                              "type": "array"
                            },
                            "platform": {
                              "type": "string"
                            },
                            "version": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "version",
                            "platform",
                            "channels"
                          ],
                          "type": "object"
                        },
                        "kind": {
                          "const": "health",
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "health"
                      ],
                      "type": "object"
                    },
                    {
                      "additionalProperties": false,
                      "properties": {
                        "channels": {
                          "items": {
                            "additionalProperties": false,
                            "properties": {
                              "credentialConnection": {
                                "anyOf": [
                                  {
                                    "maxLength": 200,
                                    "type": "string"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "enabled": {
                                "type": "boolean"
                              },
                              "name": {
                                "maxLength": 120,
                                "minLength": 1,
                                "type": "string"
                              },
                              "provider": {
                                "maxLength": 80,
                                "minLength": 1,
                                "type": "string"
                              }
                            },
                            "required": [
                              "name",
                              "provider",
                              "enabled",
                              "credentialConnection"
                            ],
                            "type": "object"
                          },
                          "maxItems": 500,
                          "type": "array"
                        },
                        "connections": {
                          "items": {
                            "additionalProperties": false,
                            "properties": {
                              "available": {
                                "type": "boolean"
                              },
                              "connection": {
                                "type": "string"
                              },
                              "identity": {
                                "anyOf": [
                                  {
                                    "additionalProperties": false,
                                    "properties": {
                                      "botUserId": {
                                        "pattern": "^[UW][A-Z0-9]+$",
                                        "type": "string"
                                      },
                                      "teamId": {
                                        "pattern": "^T[A-Z0-9]+$",
                                        "type": "string"
                                      }
                                    },
                                    "required": [
                                      "teamId",
                                      "botUserId"
                                    ],
                                    "type": "object"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              }
                            },
                            "required": [
                              "connection",
                              "identity",
                              "available"
                            ],
                            "type": "object"
                          },
                          "maxItems": 100,
                          "type": "array"
                        },
                        "kind": {
                          "const": "channels.inspect",
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "connections",
                        "channels"
                      ],
                      "type": "object"
                    },
                    {
                      "additionalProperties": false,
                      "properties": {
                        "channel": {
                          "additionalProperties": false,
                          "properties": {
                            "credentialConnection": {
                              "anyOf": [
                                {
                                  "maxLength": 200,
                                  "type": "string"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "enabled": {
                              "type": "boolean"
                            },
                            "name": {
                              "maxLength": 120,
                              "minLength": 1,
                              "type": "string"
                            },
                            "provider": {
                              "maxLength": 80,
                              "minLength": 1,
                              "type": "string"
                            }
                          },
                          "required": [
                            "name",
                            "provider",
                            "enabled",
                            "credentialConnection"
                          ],
                          "type": "object"
                        },
                        "kind": {
                          "const": "channel.configure",
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "channel"
                      ],
                      "type": "object"
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "status": {
              "enum": [
                "queued",
                "delivered",
                "succeeded",
                "failed",
                "uncertain",
                "cancelled"
              ],
              "type": "string"
            }
          },
          "required": [
            "id",
            "installationId",
            "status",
            "createdAt",
            "result",
            "error"
          ],
          "type": "object"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "operation"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the input body of `operations.show`. */
export const OperationsShowInputSchema = {
  "additionalProperties": false,
  "properties": {
    "input": {
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        }
      },
      "required": [
        "operationId"
      ],
      "type": "object"
    }
  },
  "required": [
    "input"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;

/** JSON Schema for the return shape of `operations.show`. */
export const OperationsShowReturnSchema = {
  "additionalProperties": false,
  "properties": {
    "createdAt": {
      "type": "string"
    },
    "error": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "installationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "result": {
      "anyOf": [
        {
          "oneOf": [
            {
              "additionalProperties": false,
              "properties": {
                "health": {
                  "additionalProperties": false,
                  "properties": {
                    "channels": {
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "credentialConnection": {
                            "anyOf": [
                              {
                                "maxLength": 200,
                                "type": "string"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "enabled": {
                            "type": "boolean"
                          },
                          "name": {
                            "maxLength": 120,
                            "minLength": 1,
                            "type": "string"
                          },
                          "provider": {
                            "maxLength": 80,
                            "minLength": 1,
                            "type": "string"
                          }
                        },
                        "required": [
                          "name",
                          "provider",
                          "enabled",
                          "credentialConnection"
                        ],
                        "type": "object"
                      },
                      "maxItems": 500,
                      "type": "array"
                    },
                    "platform": {
                      "type": "string"
                    },
                    "version": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "version",
                    "platform",
                    "channels"
                  ],
                  "type": "object"
                },
                "kind": {
                  "const": "health",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "health"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "channels": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "credentialConnection": {
                        "anyOf": [
                          {
                            "maxLength": 200,
                            "type": "string"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "enabled": {
                        "type": "boolean"
                      },
                      "name": {
                        "maxLength": 120,
                        "minLength": 1,
                        "type": "string"
                      },
                      "provider": {
                        "maxLength": 80,
                        "minLength": 1,
                        "type": "string"
                      }
                    },
                    "required": [
                      "name",
                      "provider",
                      "enabled",
                      "credentialConnection"
                    ],
                    "type": "object"
                  },
                  "maxItems": 500,
                  "type": "array"
                },
                "connections": {
                  "items": {
                    "additionalProperties": false,
                    "properties": {
                      "available": {
                        "type": "boolean"
                      },
                      "connection": {
                        "type": "string"
                      },
                      "identity": {
                        "anyOf": [
                          {
                            "additionalProperties": false,
                            "properties": {
                              "botUserId": {
                                "pattern": "^[UW][A-Z0-9]+$",
                                "type": "string"
                              },
                              "teamId": {
                                "pattern": "^T[A-Z0-9]+$",
                                "type": "string"
                              }
                            },
                            "required": [
                              "teamId",
                              "botUserId"
                            ],
                            "type": "object"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "connection",
                      "identity",
                      "available"
                    ],
                    "type": "object"
                  },
                  "maxItems": 100,
                  "type": "array"
                },
                "kind": {
                  "const": "channels.inspect",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "connections",
                "channels"
              ],
              "type": "object"
            },
            {
              "additionalProperties": false,
              "properties": {
                "channel": {
                  "additionalProperties": false,
                  "properties": {
                    "credentialConnection": {
                      "anyOf": [
                        {
                          "maxLength": 200,
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "enabled": {
                      "type": "boolean"
                    },
                    "name": {
                      "maxLength": 120,
                      "minLength": 1,
                      "type": "string"
                    },
                    "provider": {
                      "maxLength": 80,
                      "minLength": 1,
                      "type": "string"
                    }
                  },
                  "required": [
                    "name",
                    "provider",
                    "enabled",
                    "credentialConnection"
                  ],
                  "type": "object"
                },
                "kind": {
                  "const": "channel.configure",
                  "type": "string"
                }
              },
              "required": [
                "kind",
                "channel"
              ],
              "type": "object"
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "status": {
      "enum": [
        "queued",
        "delivered",
        "succeeded",
        "failed",
        "uncertain",
        "cancelled"
      ],
      "type": "string"
    }
  },
  "required": [
    "id",
    "installationId",
    "status",
    "createdAt",
    "result",
    "error"
  ],
  "type": "object"
} as const satisfies SdkJsonSchema;
