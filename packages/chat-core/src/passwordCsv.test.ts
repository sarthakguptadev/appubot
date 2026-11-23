import { describe, expect, it } from 'vitest';
import { PasswordFileError, parseCsv, passwordFileSummary, planLoginImport, readPasswordFile, siteOf } from './passwordCsv';

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, line breaks in a cell, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n"two\nlines",,z\n\n')).toEqual([
      ['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['two\nlines', '', 'z'],
    ]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    // a quote inside an unquoted cell is just a character
    expect(parseCsv('a,b\n5" disk,x')).toEqual([['a', 'b'], ['5" disk', 'x']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('siteOf', () => {
  it('keeps the host, without www', () => {
    expect(siteOf('https://www.GitHub.com/login?x=1')).toBe('github.com');
    expect(siteOf('accounts.google.com')).toBe('accounts.google.com');
    expect(siteOf('android://abc123==@com.spotify.music/')).toBe('com.spotify.music');
    expect(siteOf('  ')).toBe('');
    expect(siteOf('Zoho Books')).toBe('Zoho Books');
  });
});

describe('readPasswordFile', () => {
  it('reads Chrome’s export', () => {
    const f = readPasswordFile('name,url,username,password,note\ngithub.com,https://github.com/login,me@x.com,hunter2,work\naccounts.google.com,https://accounts.google.com/,me@x.com,"p,w""d",\n');
    expect(f.logins).toEqual([
      { name: 'github.com', site: 'github.com', username: 'me@x.com', password: 'hunter2', notes: 'work' },
      { name: 'accounts.google.com', site: 'accounts.google.com', username: 'me@x.com', password: 'p,w"d' },
    ]);
    expect(f).toMatchObject({ rows: 2, empty: 0, repeated: 0 });
  });

  it('reads Safari’s, Firefox’s, Bitwarden’s and LastPass’s by their headers', () => {
    expect(readPasswordFile('Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com,me,pw1,,otpauth://totp/secret').logins)
      .toEqual([{ name: 'GitHub', site: 'github.com', username: 'me', password: 'pw1' }]);
    expect(readPasswordFile('"url","username","password","httpRealm","formActionOrigin","guid"\n"https://www.example.org","u","pw2",,"https://www.example.org","{1}"').logins)
      .toEqual([{ name: 'example.org', site: 'example.org', username: 'u', password: 'pw2' }]);
    const bw = readPasswordFile('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Mail,,,0,https://mail.example.com,me,pw3,\n,,note,My note,secret text,,0,,,,');
    expect(bw.logins).toEqual([{ name: 'Mail', site: 'mail.example.com', username: 'me', password: 'pw3' }]);
    expect(bw.empty).toBe(1);
    expect(readPasswordFile('url,username,password,totp,extra,name,grouping,fav\nhttps://a.com,me,pw4,,a note,A site,,0').logins)
      .toEqual([{ name: 'A site', site: 'a.com', username: 'me', password: 'pw4', notes: 'a note' }]);
  });

  it('never reads a one-time-code secret into anything', () => {
    const f = readPasswordFile('Title,URL,Username,Password,Notes,OTPAuth\nX,https://x.com,me,pw,,otpauth://totp/TOPSECRET');
    expect(JSON.stringify(f)).not.toContain('TOPSECRET');
  });

  it('leaves out repeats, and tells same-named logins apart by username', () => {
    const f = readPasswordFile('name,url,username,password\nGitHub,https://github.com,work@x.com,a\nGitHub,https://github.com,home@x.com,b\nGitHub,https://github.com,work@x.com,a\n');
    expect(f.logins.map((l) => l.name)).toEqual(['GitHub (work@x.com)', 'GitHub (home@x.com)']);
    expect(f.repeated).toBe(1);
  });

  it('refuses what isn’t a passwords file', () => {
    expect(() => readPasswordFile('hello world')).toThrow(PasswordFileError);
    expect(() => readPasswordFile('date,amount\n2026-01-01,5')).toThrow(/passwords file/);
    expect(() => readPasswordFile('')).toThrow(PasswordFileError);
  });

  it('fits the Vault’s limits', () => {
    const long = 'x'.repeat(400);
    const l = readPasswordFile(`name,url,username,password,note\n${long},https://a.com,${long},pw,${'n'.repeat(3000)}`).logins[0]!;
    expect(l.name.length).toBe(80);
    expect(l.username.length).toBe(200);
    expect(l.notes!.length).toBe(1000);
  });
});

describe('planLoginImport', () => {
  it('finds the logins already saved, by site and username', () => {
    const file = readPasswordFile('name,url,username,password\nGitHub,https://www.github.com,Me@x.com,a\nNew,https://new.com,me,b\nNo site,,,c');
    const plan = planLoginImport(file.logins, [
      { id: 'v1', kind: 'login', name: 'GitHub', site: 'github.com', username: 'me@x.com' },
      { id: 'v2', kind: 'apiKey', name: 'new.com', site: 'new.com', username: 'me' },
      { id: 'v3', kind: 'login', name: 'Blank' },
    ]);
    expect(plan.map((r) => r.existing?.id)).toEqual(['v1', undefined, undefined]);
    expect(passwordFileSummary(file, plan)).toBe('3 logins · 1 already in the Vault');
  });
});
