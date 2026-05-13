import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile, classifyCommand, classifyContent, inferAzureObservationType } from '../azureDetect';

test('azureDetect — classifyFile bicep main', () => {
  const r = classifyFile('infra/main.bicep');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('iac-bicep'));
});

test('azureDetect — classifyFile terraform', () => {
  const r = classifyFile('infra/main.tf');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('iac-terraform'));
});

test('azureDetect — classifyFile azd yaml', () => {
  const r = classifyFile('azure.yaml');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('azd'));
});

test('azureDetect — classifyFile functions host.json', () => {
  const r = classifyFile('api/host.json');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('functions'));
});

test('azureDetect — classifyFile non-azure returns false', () => {
  const r = classifyFile('src/index.ts');
  assert.equal(r.isAzure, false);
  assert.deepEqual(r.subsystems, []);
});

test('azureDetect — classifyCommand az', () => {
  const r = classifyCommand('az group list');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('cli'));
});

test('azureDetect — classifyCommand azd up', () => {
  const r = classifyCommand('azd up');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('azd'));
});

test('azureDetect — classifyCommand kubectl', () => {
  const r = classifyCommand('kubectl get pods');
  assert.equal(r.isAzure, true);
  assert.ok(r.subsystems.includes('aks'));
});

test('azureDetect — classifyCommand non-azure', () => {
  const r = classifyCommand('npm install');
  assert.equal(r.isAzure, false);
});

test('azureDetect — classifyContent DefaultAzureCredential', () => {
  const r = classifyContent('const cred = new DefaultAzureCredential();');
  assert.equal(r.isAzure, true);
});

test('azureDetect — inferAzureObservationType infra', () => {
  assert.equal(inferAzureObservationType(['iac-bicep']), 'infra');
  assert.equal(inferAzureObservationType(['iac-terraform']), 'infra');
});

test('azureDetect — inferAzureObservationType deployment', () => {
  assert.equal(inferAzureObservationType(['azd']), 'deployment');
  assert.equal(inferAzureObservationType(['cli']), 'deployment');
});

test('azureDetect — inferAzureObservationType none for runtime', () => {
  assert.equal(inferAzureObservationType(['functions']), undefined);
  assert.equal(inferAzureObservationType([]), undefined);
});
