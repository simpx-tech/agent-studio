import { describe, it, expect } from 'vitest';
import {
  compactPath,
  describeFolders,
  expandHome,
  filterFolders,
  isAbsolutePath,
  pathSegments,
} from './folders';

describe('folder browser helpers', () => {
  it('splits Windows, POSIX, and UNC paths into clickable ancestors', () => {
    expect(pathSegments('C:\\Users\\dev\\Projects')).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'dev', path: 'C:\\Users\\dev' },
      { name: 'Projects', path: 'C:\\Users\\dev\\Projects' },
    ]);
    expect(pathSegments('c:/mixed/slashes/')).toEqual([
      { name: 'C:\\', path: 'C:\\' },
      { name: 'mixed', path: 'C:\\mixed' },
      { name: 'slashes', path: 'C:\\mixed\\slashes' },
    ]);
    expect(pathSegments('D:\\')).toEqual([{ name: 'D:\\', path: 'D:\\' }]);
    expect(pathSegments('/home/test/studio')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'test', path: '/home/test' },
      { name: 'studio', path: '/home/test/studio' },
    ]);
    expect(pathSegments('/')).toEqual([{ name: '/', path: '/' }]);
    expect(pathSegments('\\\\server\\share\\team\\repo')).toEqual([
      { name: '\\\\server\\share', path: '\\\\server\\share' },
      { name: 'team', path: '\\\\server\\share\\team' },
      { name: 'repo', path: '\\\\server\\share\\team\\repo' },
    ]);
    expect(pathSegments('  ')).toEqual([]);
    expect(pathSegments('relative/path')).toEqual([
      { name: 'relative/path', path: 'relative/path' },
    ]);
  });

  it('recognizes absolute paths and expands the reported home folder', () => {
    expect(isAbsolutePath('/home/test')).toBe(true);
    expect(isAbsolutePath(' C:\\Projects ')).toBe(true);
    expect(isAbsolutePath('d:/work')).toBe(true);
    expect(isAbsolutePath('\\\\nas\\share')).toBe(true);
    expect(isAbsolutePath('studio')).toBe(false);
    expect(isAbsolutePath('~/studio')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
    expect(expandHome('~/studio', '/home/test')).toBe('/home/test/studio');
    expect(expandHome('~', '/home/test/')).toBe('/home/test/');
    expect(expandHome('~\\Projects', 'C:\\Users\\dev')).toBe('C:\\Users\\dev\\Projects');
    expect(expandHome('~/studio')).toBe('~/studio');
    expect(expandHome('/absolute', '/home/test')).toBe('/absolute');
  });

  it('compacts long paths while keeping short ones intact', () => {
    expect(compactPath('C:\\Users\\dev\\Documents\\Github\\studio')).toBe('C:\\…\\Github\\studio');
    expect(compactPath('/home/test/projects/studio')).toBe('/…/projects/studio');
    expect(compactPath('/home/test/studio')).toBe('/home/test/studio');
    expect(compactPath('C:\\Projects')).toBe('C:\\Projects');
    expect(compactPath('/home/test/projects/studio', 1)).toBe('/…/studio');
  });

  it('filters hidden folders and ranks prefix matches first', () => {
    const entries = [
      { name: '.git', path: '/r/.git', hidden: true },
      { name: 'archive', path: '/r/archive' },
      { name: 'studio', path: '/r/studio', repository: true },
      { name: 'my-studio-fork', path: '/r/my-studio-fork' },
      { name: 'tools', path: '/r/tools' },
    ];
    expect(filterFolders(entries).map((e) => e.name)).toEqual([
      'archive',
      'studio',
      'my-studio-fork',
      'tools',
    ]);
    expect(filterFolders(entries, { showHidden: true }).map((e) => e.name)).toEqual([
      '.git',
      'archive',
      'studio',
      'my-studio-fork',
      'tools',
    ]);
    expect(filterFolders(entries, { query: ' STUD ' }).map((e) => e.name)).toEqual([
      'studio',
      'my-studio-fork',
    ]);
    expect(filterFolders(entries, { query: 'git' })).toEqual([]);
    expect(filterFolders(entries, { query: 'git', showHidden: true }).map((e) => e.name)).toEqual([
      '.git',
    ]);
    expect(describeFolders(entries)).toBe('5 folders · 1 repository · 1 hidden');
    expect(describeFolders([entries[1]])).toBe('1 folder');
    expect(describeFolders([])).toBe('0 folders');
  });
});
