'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class ConfigStore {
  constructor(filePath) { this.filePath = filePath; }
  async load(defaultValue = {}) {
    try { return JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return structuredClone(defaultValue);
      throw error;
    }
  }
  async save(value) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}

module.exports = { ConfigStore };
