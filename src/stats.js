'use strict';
const fs = require('fs');
const os = require('os');
const checkDiskSpace = require('check-disk-space').default;

function parseXmxMB(javaArgs) {
  const arg = (javaArgs || []).find((a) => /^-Xmx/i.test(a));
  if (!arg) return null;
  const m = arg.match(/^-Xmx(\d+)([kKmMgG])?$/);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  const unit = (m[2] || 'm').toLowerCase();
  if (unit === 'g') return val * 1024;
  if (unit === 'k') return val / 1024;
  return val; // m
}

class StatsSampler {
  constructor(config, processManager) {
    this.config = config;
    this.pm = processManager;
    this.clockTicks = 100; // USER_HZ — standard on Linux
    this._prev = null; // { utime, stime, hz_time }
    this.memMaxMB = parseXmxMB(config.server.javaArgs) || 4096;
  }

  async _readProcCpuMem(pid) {
    const statRaw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields are space separated; the comm field (2nd) may contain spaces/parens,
    // so split off everything after the closing paren.
    const afterComm = statRaw.slice(statRaw.lastIndexOf(')') + 2).trim().split(/\s+/);
    // Per proc(5): fields after comm start at index 3 (state). utime=14th, stime=15th
    // overall field, i.e. index 11 and 12 in afterComm (0-based, starting at field 3).
    const utime = parseInt(afterComm[11], 10);
    const stime = parseInt(afterComm[12], 10);

    const statusRaw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssMatch = statusRaw.match(/VmRSS:\s+(\d+)\s+kB/);
    const rssMB = rssMatch ? parseInt(rssMatch[1], 10) / 1024 : 0;

    return { utime, stime, rssMB };
  }

  async sample() {
    const pid = this.pm.getPid();
    let cpuPct = 0;
    let memMB = 0;

    if (pid) {
      try {
        const { utime, stime, rssMB } = await this._readProcCpuMem(pid);
        memMB = rssMB;
        const now = Date.now();
        const totalTicks = utime + stime;
        if (this._prev) {
          const dTicks = totalTicks - this._prev.totalTicks;
          const dMs = now - this._prev.time;
          const cores = os.cpus().length || 1;
          if (dMs > 0) {
            cpuPct = ((dTicks / this.clockTicks) * 1000 / dMs) * 100 / cores;
            cpuPct = Math.max(0, Math.min(100, cpuPct));
          }
        }
        this._prev = { totalTicks, time: now };
      } catch (err) {
        // process likely exited mid-read; ignore this tick
        this._prev = null;
      }
    } else {
      this._prev = null;
    }

    let disk = { usedGB: 0, sizeGB: 0 };
    try {
      const d = await checkDiskSpace(this.config.server.directory);
      disk = {
        usedGB: (d.size - d.free) / (1024 ** 3),
        sizeGB: d.size / (1024 ** 3),
      };
    } catch (err) {
      // disk-space check can fail on unusual filesystems; keep zeros
    }

    return {
      cpuPct: Number(cpuPct.toFixed(1)),
      memMB: Number(memMB.toFixed(0)),
      memMaxMB: this.memMaxMB,
      disk,
    };
  }
}

module.exports = StatsSampler;
