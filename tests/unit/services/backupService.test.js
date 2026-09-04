const fs = require('fs');
const os = require('os');
const path = require('path');
const BackupService = require('../../../services/backupService');

describe('BackupService retention', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-backup-test-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('keeps only the newest seven daily backups', () => {
        for (let day = 1; day <= 10; day++) fs.writeFileSync(path.join(dir, `daily-2026-08-${String(day).padStart(2, '0')}.sql.gz`), 'backup');
        BackupService.pruneBackups(dir, 'daily-', 7);
        const remaining = fs.readdirSync(dir).sort();
        expect(remaining).toHaveLength(7);
        expect(remaining[0]).toBe('daily-2026-08-04.sql.gz');
        expect(remaining[6]).toBe('daily-2026-08-10.sql.gz');
    });

    test('keeps only the newest four weekly backups', () => {
        for (let week = 1; week <= 6; week++) fs.writeFileSync(path.join(dir, `weekly-2026-0${week}-01.sql.gz`), 'backup');
        BackupService.pruneBackups(dir, 'weekly-', 4);
        expect(fs.readdirSync(dir).sort()).toEqual([
            'weekly-2026-03-01.sql.gz', 'weekly-2026-04-01.sql.gz',
            'weekly-2026-05-01.sql.gz', 'weekly-2026-06-01.sql.gz'
        ]);
    });
});
