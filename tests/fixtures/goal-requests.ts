export type GoalRequestFixture = {
  id: string;
  category:
    | 'ambiguous'
    | 'changed-goal'
    | 'stale-state'
    | 'resource-conflict'
    | 'environment-change'
    | 'clear-navigation';
  input: string;
  target?: { x: number; y: number; z: number };
  expected: 'clarify' | 'accept' | 'reject' | 'replan';
};
const cases: GoalRequestFixture[] = [
  { id: 'ambiguous-01', category: 'ambiguous', input: 'Go somewhere nice', expected: 'clarify' },
  {
    id: 'ambiguous-02',
    category: 'ambiguous',
    input: 'Get me some resources',
    expected: 'clarify',
  },
  { id: 'ambiguous-03', category: 'ambiguous', input: 'Go to that place', expected: 'clarify' },
  { id: 'ambiguous-04', category: 'ambiguous', input: 'Build it over there', expected: 'clarify' },
  { id: 'ambiguous-05', category: 'ambiguous', input: 'Do the usual thing', expected: 'clarify' },
  {
    id: 'changed-01',
    category: 'changed-goal',
    input: 'Change target to 4 1 0',
    target: { x: 4, y: 1, z: 0 },
    expected: 'accept',
  },
  {
    id: 'changed-02',
    category: 'changed-goal',
    input: 'Cancel previous route and go to -2 1 3',
    target: { x: -2, y: 1, z: 3 },
    expected: 'accept',
  },
  { id: 'changed-03', category: 'changed-goal', input: 'Actually stop now', expected: 'accept' },
  {
    id: 'changed-04',
    category: 'changed-goal',
    input: 'New target is 0 1 -5',
    target: { x: 0, y: 1, z: -5 },
    expected: 'accept',
  },
  {
    id: 'changed-05',
    category: 'changed-goal',
    input: 'Ignore my last request; head to 6 1 2',
    target: { x: 6, y: 1, z: 2 },
    expected: 'accept',
  },
  {
    id: 'stale-01',
    category: 'stale-state',
    input: 'Use the old position from yesterday',
    expected: 'reject',
  },
  {
    id: 'stale-02',
    category: 'stale-state',
    input: 'Continue on expired route plan',
    expected: 'replan',
  },
  {
    id: 'stale-03',
    category: 'stale-state',
    input: 'The block changed since that snapshot',
    expected: 'replan',
  },
  {
    id: 'stale-04',
    category: 'stale-state',
    input: 'Move using an old session result',
    expected: 'reject',
  },
  {
    id: 'stale-05',
    category: 'stale-state',
    input: 'Target observation is past its validity',
    expected: 'replan',
  },
  {
    id: 'resource-01',
    category: 'resource-conflict',
    input: 'Open chest while another task owns container',
    expected: 'reject',
  },
  {
    id: 'resource-02',
    category: 'resource-conflict',
    input: 'Preempt lower priority movement',
    expected: 'accept',
  },
  {
    id: 'resource-03',
    category: 'resource-conflict',
    input: 'Acquire move and look atomically',
    expected: 'accept',
  },
  {
    id: 'resource-04',
    category: 'resource-conflict',
    input: 'Take a non-preemptible occupied slot',
    expected: 'reject',
  },
  {
    id: 'resource-05',
    category: 'resource-conflict',
    input: 'Move while inventory channel is free',
    expected: 'accept',
  },
  {
    id: 'environment-01',
    category: 'environment-change',
    input: 'Obstacle appeared on current path',
    expected: 'replan',
  },
  {
    id: 'environment-02',
    category: 'environment-change',
    input: 'Dimension changed to nether',
    expected: 'replan',
  },
  {
    id: 'environment-03',
    category: 'environment-change',
    input: 'Connection dropped and returned',
    expected: 'replan',
  },
  {
    id: 'environment-04',
    category: 'environment-change',
    input: 'A nearby entity entered the route',
    expected: 'replan',
  },
  {
    id: 'environment-05',
    category: 'environment-change',
    input: 'Support block disappeared underfoot',
    expected: 'replan',
  },
  {
    id: 'navigation-01',
    category: 'clear-navigation',
    input: 'Navigate to 1 1 0',
    target: { x: 1, y: 1, z: 0 },
    expected: 'accept',
  },
  {
    id: 'navigation-02',
    category: 'clear-navigation',
    input: 'Navigate to 0 1 1',
    target: { x: 0, y: 1, z: 1 },
    expected: 'accept',
  },
  {
    id: 'navigation-03',
    category: 'clear-navigation',
    input: 'Navigate to -1 1 0',
    target: { x: -1, y: 1, z: 0 },
    expected: 'accept',
  },
  {
    id: 'navigation-04',
    category: 'clear-navigation',
    input: 'Navigate to 0 1 -1',
    target: { x: 0, y: 1, z: -1 },
    expected: 'accept',
  },
  {
    id: 'navigation-05',
    category: 'clear-navigation',
    input: 'Navigate to 3 1 2',
    target: { x: 3, y: 1, z: 2 },
    expected: 'accept',
  },
];
export const goalRequestFixtures = cases;
