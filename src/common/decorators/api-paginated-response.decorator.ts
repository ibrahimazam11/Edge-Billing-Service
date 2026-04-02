import { applyDecorators, Type } from "@nestjs/common";
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from "@nestjs/swagger";

export const ApiPaginatedResponse = <TModel extends Type>(model: TModel) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      schema: {
        properties: {
          data: {
            type: "array",
            items: { $ref: getSchemaPath(model) },
          },
          cursor: {
            type: "string",
            nullable: true,
          },
          hasMore: {
            type: "boolean",
          },
        },
        required: ["data", "cursor", "hasMore"],
      },
    }),
  );
