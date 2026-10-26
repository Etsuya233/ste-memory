import { Type } from "typebox";

export const tablePresetVectorIndexSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    updateMode: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
    groups: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          name: Type.String(),
          fieldKeys: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
