import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.constants';

// Expo-Gateway LATENCY_BUCKETS: use the same boundaries for common RED queries.
const LATENCY_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04,
  0.05, 0.06, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const runtimeRegistry = new Registry();
let runtimeCollected = false;

@Injectable()
export class MetricsProvider implements OnModuleInit, OnApplicationShutdown {
  readonly registry = new Registry();
  private readonly duration: Histogram<'method' | 'status' | 'uri'>;
  private server?: Server;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.duration = new Histogram({
      name: 'http_server_requests_seconds',
      help: 'HTTP server request duration in seconds',
      labelNames: ['method', 'status', 'uri'],
      buckets: [...LATENCY_BUCKETS],
      registers: [this.registry],
    });
  }

  get address(): AddressInfo | undefined {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address : undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.metrics.enabled || this.server) return;
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.registry.metrics().then(
        (body) => {
          res.writeHead(200, { 'Content-Type': this.registry.contentType });
          res.end(body);
        },
        () => res.writeHead(500).end(),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.metrics.port, this.config.metrics.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    if (!runtimeCollected) {
      collectDefaultMetrics({ register: runtimeRegistry });
      runtimeCollected = true;
    }
    for (const metric of runtimeRegistry.getMetricsAsArray()) {
      const collector = runtimeRegistry.getSingleMetric(metric.name);
      if (collector) this.registry.registerMetric(collector);
    }
  }

  observe(labels: {
    readonly method: string;
    readonly status: string;
    readonly uri: string;
    readonly seconds: number;
  }): void {
    if (!this.address) return;
    const { seconds, ...values } = labels;
    this.duration.observe(values, seconds);
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.registry.clear();
  }
}
