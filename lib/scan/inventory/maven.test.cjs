'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FILES, parse } = require('./maven.cjs');

const POM = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<project xmlns="http://maven.apache.org/POM/4.0.0">',
  '  <modelVersion>4.0.0</modelVersion>',
  '  <groupId>com.example</groupId>',
  '  <artifactId>app</artifactId>',
  '  <version>1.0.0</version>',
  '',
  '  <properties>',
  '    <spring.version>6.1.2</spring.version>',
  '    <junit.version>5.10.1</junit.version>',
  '  </properties>',
  '',
  '  <!-- managed versions only; these must not show up in the inventory',
  '       <dependency><groupId>never</groupId><artifactId>seen</artifactId></dependency> -->',
  '  <dependencyManagement>',
  '    <dependencies>',
  '      <dependency>',
  '        <groupId>com.fasterxml.jackson</groupId>',
  '        <artifactId>jackson-bom</artifactId>',
  '        <version>2.16.1</version>',
  '        <type>pom</type>',
  '        <scope>import</scope>',
  '      </dependency>',
  '    </dependencies>',
  '  </dependencyManagement>',
  '',
  '  <dependencies>',
  '    <dependency>',
  '      <groupId>org.springframework</groupId>',
  '      <artifactId>spring-core</artifactId>',
  '      <version>${spring.version}</version>',
  '      <exclusions>',
  '        <exclusion>',
  '          <groupId>commons-logging</groupId>',
  '          <artifactId>commons-logging</artifactId>',
  '        </exclusion>',
  '      </exclusions>',
  '    </dependency>',
  '    <dependency>',
  '      <groupId>org.junit.jupiter</groupId>',
  '      <artifactId>junit-jupiter</artifactId>',
  '      <version>${junit.version}</version>',
  '      <scope>test</scope>',
  '    </dependency>',
  '    <dependency>',
  '      <groupId>javax.servlet</groupId>',
  '      <artifactId>javax.servlet-api</artifactId>',
  '      <version>4.0.1</version>',
  '      <scope>provided</scope>',
  '    </dependency>',
  '    <dependency>',
  '      <groupId>com.google.guava</groupId>',
  '      <artifactId>guava</artifactId>',
  '      <version>33.0.0-jre</version>',
  '      <optional>true</optional>',
  '    </dependency>',
  '    <dependency>',
  '      <groupId>org.slf4j</groupId>',
  '      <artifactId>slf4j-api</artifactId>',
  '      <version>2.0.11</version>',
  '      <scope>runtime</scope>',
  '    </dependency>',
  '    <dependency>',
  '      <groupId>com.fasterxml.jackson.core</groupId>',
  '      <artifactId>jackson-databind</artifactId>',
  '    </dependency>',
  '  </dependencies>',
  '',
  '  <build>',
  '    <plugins>',
  '      <plugin>',
  '        <groupId>org.apache.maven.plugins</groupId>',
  '        <artifactId>maven-surefire-plugin</artifactId>',
  '        <version>3.2.5</version>',
  '        <dependencies>',
  '          <dependency>',
  '            <groupId>org.junit.platform</groupId>',
  '            <artifactId>junit-platform-launcher</artifactId>',
  '            <version>1.10.1</version>',
  '          </dependency>',
  '        </dependencies>',
  '      </plugin>',
  '    </plugins>',
  '  </build>',
  '</project>',
  '',
].join('\n');

function byName(packages, name) {
  return packages.find((p) => p.name === name);
}

test('MAVEN-1 dependency blocks become groupId:artifactId packages', () => {
  const { packages } = parse(POM, { file: 'pom.xml' });

  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:maven/org.springframework/spring-core@6.1.2',
    'pkg:maven/org.junit.jupiter/junit-jupiter@5.10.1',
    'pkg:maven/javax.servlet/javax.servlet-api@4.0.1',
    'pkg:maven/com.google.guava/guava@33.0.0-jre',
    'pkg:maven/org.slf4j/slf4j-api@2.0.11',
    'pkg:maven/com.fasterxml.jackson.core/jackson-databind',
  ]);
  assert.equal(packages.every((p) => p.direct === true), true);
  assert.equal(packages.every((p) => p.ecosystem === 'Maven'), true);
  assert.equal(packages.every((p) => p.source === 'pom.xml'), true);
});

test('MAVEN-2 ${property} versions resolve against the properties block', () => {
  const { packages } = parse(POM, { file: 'pom.xml' });

  assert.equal(byName(packages, 'org.springframework:spring-core').version, '6.1.2');
  assert.equal(byName(packages, 'org.junit.jupiter:junit-jupiter').version, '5.10.1');
});

test('MAVEN-3 maven scopes map onto inventory scopes', () => {
  const { packages } = parse(POM, { file: 'pom.xml' });

  assert.equal(byName(packages, 'org.springframework:spring-core').scope, 'prod');
  assert.equal(byName(packages, 'org.slf4j:slf4j-api').scope, 'prod');
  assert.equal(byName(packages, 'com.fasterxml.jackson.core:jackson-databind').scope, 'prod');
  assert.equal(byName(packages, 'org.junit.jupiter:junit-jupiter').scope, 'dev');
  assert.equal(byName(packages, 'javax.servlet:javax.servlet-api').scope, 'dev');
  assert.equal(byName(packages, 'com.google.guava:guava').scope, 'optional');
});

test('MAVEN-4 dependencyManagement, plugin and comment blocks are ignored', () => {
  const { packages } = parse(POM, { file: 'pom.xml' });

  assert.equal(byName(packages, 'com.fasterxml.jackson:jackson-bom'), undefined);
  assert.equal(byName(packages, 'org.junit.platform:junit-platform-launcher'), undefined);
  assert.equal(byName(packages, 'never:seen'), undefined);
  assert.equal(byName(packages, 'commons-logging:commons-logging'), undefined);
  assert.equal(packages.length, 6);
});

test('MAVEN-5 an absent or unresolvable version yields null plus a warning', () => {
  const content = [
    '<project>',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>com.example</groupId>',
    '      <artifactId>inherited</artifactId>',
    '    </dependency>',
    '    <dependency>',
    '      <groupId>com.example</groupId>',
    '      <artifactId>dangling</artifactId>',
    '      <version>${nowhere.version}</version>',
    '    </dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'modules/api/pom.xml' });

  assert.deepEqual(packages.map((p) => p.version), [null, null]);
  assert.deepEqual(packages.map((p) => p.purl), [
    'pkg:maven/com.example/inherited',
    'pkg:maven/com.example/dangling',
  ]);
  assert.deepEqual(warnings, ['unresolved-version']);
  assert.equal(packages[0].source, 'modules/api/pom.xml');
});

test('MAVEN-6 unknown basename reports unsupported-file', () => {
  assert.deepEqual(parse(POM, { file: 'build.gradle' }), { packages: [], warnings: ['unsupported-file'] });
});

test('MAVEN-7 a dependency missing its coordinates warns instead of throwing', () => {
  const content = [
    '<project>',
    '  <dependencies>',
    '    <dependency>',
    '      <groupId>com.example</groupId>',
    '      <artifactId>fine</artifactId>',
    '      <version>1.0.0</version>',
    '    </dependency>',
    '    <dependency>',
    '      <groupId>com.example</groupId>',
    '    </dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n');

  const { packages, warnings } = parse(content, { file: 'pom.xml' });

  assert.deepEqual(packages.map((p) => p.purl), ['pkg:maven/com.example/fine@1.0.0']);
  assert.deepEqual(warnings, ['malformed-dependency']);
});

test('MAVEN-8 FILES is a frozen list of the handled basenames', () => {
  assert.deepEqual([...FILES], ['pom.xml']);
  assert.equal(Object.isFrozen(FILES), true);
});
