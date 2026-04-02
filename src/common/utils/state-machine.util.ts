import { StateTransitionException } from "../exceptions/billing.exception";

export type AllowedTransitions<T extends string> = Record<T, T[]>;

export function validateTransition<T extends string>(
  currentState: T,
  targetState: T,
  allowedTransitions: AllowedTransitions<T>,
): void {
  const allowed = allowedTransitions[currentState];

  if (!allowed || !allowed.includes(targetState)) {
    throw new StateTransitionException(
      `Invalid state transition from '${currentState}' to '${targetState}'`,
      {
        currentState,
        targetState,
        allowedTransitions: allowed || [],
      },
    );
  }
}
