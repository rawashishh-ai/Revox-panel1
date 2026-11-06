declare module '@cashfreepayments/cashfree-js' {
  export interface CashfreeComponent {
    mount: (element: HTMLElement | string) => void;
    unmount?: () => void;
  }

  export interface CashfreeInstance {
    create: (
      componentName: string,
      options?: {
        values?: Record<string, unknown>;
        style?: Record<string, unknown>;
      }
    ) => CashfreeComponent;
    pay: (options: {
      paymentMethod: CashfreeComponent;
      paymentSessionId: string;
      redirectTarget?: string;
    }) => Promise<unknown>;
    checkout: (options: {
      paymentSessionId: string;
      redirectTarget?: string;
    }) => Promise<unknown>;
  }

  export function load(options: {
    mode: 'production' | 'sandbox';
  }): Promise<CashfreeInstance | null>;
}
