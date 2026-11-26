import { describe, expect, it } from 'vitest';
import { searchApps } from './apps';

const app = (slug: string, name: string, description: string, categories: string[] = []) => ({ slug, name, description, categories });
const APPS = [
  app('gmail', 'Gmail', 'Read, search, draft and send email from your inbox', ['productivity', 'communication']),
  app('googlecalendar', 'Google Calendar', 'Find free time, create events and send invites', ['productivity']),
  app('github', 'GitHub', 'Issues, pull requests, repositories and reviews', ['developer-tools']),
  app('salesforce', 'Salesforce', 'Leads, accounts and opportunities', ['crm']),
  app('agilecrm', 'Agile CRM', 'Contacts and deals', ['crm']),
  app('mailchimp', 'Mailchimp', 'Audiences, campaigns and reports', ['marketing']),
  app('hubspot', 'HubSpot', 'Contacts, deals and marketing emails', ['crm', 'marketing']),
];
const CATEGORIES = [{ id: 'crm', name: 'CRM' }, { id: 'developer-tools', name: 'Developer Tools' }, { id: 'productivity', name: 'Productivity' }, { id: 'marketing', name: 'Marketing' }, { id: 'communication', name: 'Communication' }];
const find = (q: string) => searchApps(APPS, q, CATEGORIES).map((t) => t.slug);

describe('searchApps', () => {
  it('finds an app by its name, the start of it or a part of it, in any case and spacing', () => {
    expect(find('gmail')[0]).toBe('gmail');
    expect(find('GMAIL')[0]).toBe('gmail');
    expect(find('  Gmail  ')[0]).toBe('gmail');
    expect(find('goog')).toEqual(['googlecalendar']);
    expect(find('hub')).toEqual(['hubspot', 'github']);
    expect(find('google   cal')).toEqual(['googlecalendar']);
  });

  it('ranks the very name, then a name that starts with it, then one that has it, then the description', () => {
    expect(find('mail')).toEqual(['mailchimp', 'gmail', 'hubspot']);
  });

  it('finds a word of the description, and several words wherever each one is', () => {
    expect(find('inbox')).toEqual(['gmail']);
    expect(find('send email')).toEqual(['gmail']);
    expect(find('pull requests')).toEqual(['github']);
    expect(find('deals contacts')).toEqual(['agilecrm', 'hubspot']);
  });

  it('finds the apps of a category by its name', () => {
    expect(find('crm')).toEqual(['agilecrm', 'salesforce', 'hubspot']);
    expect(find('Developer Tools')).toEqual(['github']);
    expect(find('develop')).toEqual(['github']);
  });

  it('keeps a letter or two to names, and finds nothing for what no app has', () => {
    expect(find('g')).toEqual(['gmail', 'googlecalendar', 'github', 'agilecrm']);
    expect(find('xyzzy')).toEqual([]);
    expect(find('send xyzzy')).toEqual([]);
  });

  it('gives back the whole list for an empty search', () => {
    expect(find('   ')).toHaveLength(APPS.length);
  });
});
