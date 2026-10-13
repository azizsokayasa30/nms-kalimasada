import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

loadEnv({ path: resolve(process.cwd(), '.env') });

async function bootstrap() {
  const { startEmbeddedPostgres } = await import('./infra/embedded-postgres');
  await startEmbeddedPostgres();
  const { execSync } = await import('child_process');
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit', cwd: process.cwd() });

  const { ValidationPipe, Logger } = await import('@nestjs/common');
  const { NestFactory } = await import('@nestjs/core');
  const helmet = (await import('helmet')).default;
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`Kalimasada API di http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
