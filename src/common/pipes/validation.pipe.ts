import { ValidationPipe as NestValidationPipe } from "@nestjs/common";

export const globalValidationPipe = new NestValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
});
