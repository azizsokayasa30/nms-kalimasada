declare module 'embedded-postgres' {
  export default class EmbeddedPostgres {
    constructor(options?: {
      databaseDir?: string;
      port?: number;
      user?: string;
      password?: string;
      persistent?: boolean;
      onLog?: (message: string) => void;
      onError?: (message: unknown) => void;
    });
    initialise(): Promise<void>;
    start(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  }
}
