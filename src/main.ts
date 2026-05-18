import "./instrument";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { globalValidationPipe } from "./common/pipes/validation.pipe";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import { CorrelationIdInterceptor } from "./common/interceptors/correlation-id.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(globalValidationPipe);
  // GlobalExceptionFilter is the only HTTP-layer Sentry capture site. We
  // intentionally do NOT register @sentry/nestjs/setup#SentryGlobalFilter:
  // having both would double-capture every 5xx, and our filter already calls
  // Sentry.captureException with the tags we want.
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());

  const config = new DocumentBuilder()
    .setTitle("Billing Service API")
    .setDescription("API documentation for the Edge Billing Service")
    .setVersion("1.0")
    .addApiKey(
      {
        type: "apiKey",
        name: "x-api-key",
        in: "header",
        description: "API key for HMAC authentication",
      },
      "x-api-key",
    )
    .addApiKey(
      {
        type: "apiKey",
        name: "x-signature",
        in: "header",
        description:
          "HMAC-SHA256 signature of: METHOD + PATH + TIMESTAMP + SHA256(BODY)",
      },
      "x-signature",
    )
    .addApiKey(
      {
        type: "apiKey",
        name: "x-timestamp",
        in: "header",
        description:
          "Unix timestamp in milliseconds (must be within 5-minute window)",
      },
      "x-timestamp",
    )
    .addSecurityRequirements("x-api-key")
    .addSecurityRequirements("x-signature")
    .addSecurityRequirements("x-timestamp")
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api-docs", app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
void bootstrap();
